// P2P networking for distributed mining pool
// 
// Simple, robust P2P implementation using libp2p

use crate::{Error, Result, NetworkConfig, Peer, PeerId, P2PoolEvent, Share, Block};
use libp2p::{
    gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode, ConfigBuilder},
    kad::{self, store::MemoryStore, Kademlia},
    mdns,
    noise,
    ping,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp,
    yamux,
    Swarm, Transport, PeerId as LibP2PPeerId,
    identify,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tracing::{debug, info, warn, error};

/// P2P network message types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkMessage {
    ShareAnnouncement(Share),
    BlockAnnouncement(Block),
    PeerRequest,
    PeerResponse(Vec<Peer>),
    StatusRequest,
    StatusResponse(NetworkStatus),
}

/// Network status information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStatus {
    pub peer_count: usize,
    pub hash_rate: u64,
    pub last_block_height: u64,
    pub version: String,
}

/// Network behavior combining multiple protocols
#[derive(NetworkBehaviour)]
pub struct P2PoolBehaviour {
    gossipsub: gossipsub::Behaviour,
    kademlia: Kademlia<MemoryStore>,
    mdns: mdns::async_io::Behaviour,
    ping: ping::Behaviour,
    identify: identify::Behaviour,
}

/// P2P Network manager
pub struct P2PNetwork {
    swarm: Swarm<P2PoolBehaviour>,
    event_sender: mpsc::UnboundedSender<P2PoolEvent>,
    event_receiver: mpsc::UnboundedReceiver<P2PoolEvent>,
    peers: HashMap<LibP2PPeerId, Peer>,
    config: NetworkConfig,
    running: bool,
}

impl P2PNetwork {
    /// Create new P2P network instance
    pub async fn new(config: NetworkConfig) -> Result<Self> {
        info!("Initializing P2P network on port {}", config.listen_port);
        
        // Create event channel
        let (event_sender, event_receiver) = mpsc::unbounded_channel();
        
        // Generate keypair
        let local_key = libp2p::identity::Keypair::generate_ed25519();
        let local_peer_id = LibP2PPeerId::from(local_key.public());
        info!("Local peer ID: {}", local_peer_id);
        
        // Create transport
        let transport = tcp::async_io::Transport::default()
            .upgrade(libp2p::core::upgrade::Version::V1)
            .authenticate(noise::Config::new(&local_key).unwrap())
            .multiplex(yamux::Config::default())
            .boxed();
        
        // Configure Gossipsub
        let gossipsub_config = ConfigBuilder::default()
            .heartbeat_interval(std::time::Duration::from_secs(10))
            .validation_mode(ValidationMode::Strict)
            .build()
            .map_err(|e| Error::network(format!("Gossipsub config error: {}", e)))?;
        
        let mut gossipsub = gossipsub::Behaviour::new(
            MessageAuthenticity::Signed(local_key.clone()),
            gossipsub_config,
        ).map_err(|e| Error::network(format!("Gossipsub init error: {}", e)))?;
        
        // Subscribe to topics
        let share_topic = IdentTopic::new("p2pool-shares");
        let block_topic = IdentTopic::new("p2pool-blocks");
        let status_topic = IdentTopic::new("p2pool-status");
        
        gossipsub.subscribe(&share_topic)
            .map_err(|e| Error::network(format!("Subscribe error: {}", e)))?;
        gossipsub.subscribe(&block_topic)
            .map_err(|e| Error::network(format!("Subscribe error: {}", e)))?;
        gossipsub.subscribe(&status_topic)
            .map_err(|e| Error::network(format!("Subscribe error: {}", e)))?;
        
        // Configure Kademlia
        let store = MemoryStore::new(local_peer_id);
        let kademlia = Kademlia::new(local_peer_id, store);
        
        // Configure mDNS
        let mdns = mdns::async_io::Behaviour::new(
            mdns::Config::default(),
            local_peer_id,
        ).map_err(|e| Error::network(format!("mDNS init error: {}", e)))?;
        
        // Configure ping
        let ping = ping::Behaviour::new(ping::Config::new().with_keep_alive(true));
        
        // Configure identify
        let identify = identify::Behaviour::new(identify::Config::new(
            "/p2pool/1.0.0".to_string(),
            local_key.public(),
        ));
        
        // Create behavior
        let behaviour = P2PoolBehaviour {
            gossipsub,
            kademlia,
            mdns,
            ping,
            identify,
        };
        
        // Create swarm
        let mut swarm = Swarm::with_async_std_executor(transport, behaviour, local_peer_id);
        
        // Listen on all interfaces
        swarm.listen_on(format!("/ip4/0.0.0.0/tcp/{}", config.listen_port).parse().unwrap())
            .map_err(|e| Error::network(format!("Listen error: {}", e)))?;
        
        Ok(Self {
            swarm,
            event_sender,
            event_receiver,
            peers: HashMap::new(),
            config,
            running: false,
        })
    }
    
    /// Start the P2P network
    pub async fn start(&mut self) -> Result<()> {
        info!("Starting P2P network");
        self.running = true;
        
        // Connect to bootstrap peers
        for peer_addr in &self.config.bootstrap_peers {
            if let Ok(addr) = peer_addr.parse() {
                if let Err(e) = self.swarm.dial(addr) {
                    warn!("Failed to dial bootstrap peer {}: {}", peer_addr, e);
                }
            }
        }
        
        // Start event loop
        self.run_event_loop().await
    }
    
    /// Stop the P2P network
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping P2P network");
        self.running = false;
        Ok(())
    }
    
    /// Broadcast share to network
    pub fn broadcast_share(&mut self, share: &Share) -> Result<()> {
        let message = NetworkMessage::ShareAnnouncement(share.clone());
        let data = serde_json::to_vec(&message)
            .map_err(|e| Error::network(format!("Serialize error: {}", e)))?;
        
        let topic = IdentTopic::new("p2pool-shares");
        self.swarm.behaviour_mut().gossipsub.publish(topic, data)
            .map_err(|e| Error::network(format!("Publish error: {}", e)))?;
        
        debug!("Broadcasted share: {}", share.id);
        Ok(())
    }
    
    /// Broadcast block to network
    pub fn broadcast_block(&mut self, block: &Block) -> Result<()> {
        let message = NetworkMessage::BlockAnnouncement(block.clone());
        let data = serde_json::to_vec(&message)
            .map_err(|e| Error::network(format!("Serialize error: {}", e)))?;
        
        let topic = IdentTopic::new("p2pool-blocks");
        self.swarm.behaviour_mut().gossipsub.publish(topic, data)
            .map_err(|e| Error::network(format!("Publish error: {}", e)))?;
        
        info!("Broadcasted block: {}", block.hash);
        Ok(())
    }
    
    /// Get connected peers
    pub fn get_peers(&self) -> Vec<Peer> {
        self.peers.values().cloned().collect()
    }
    
    /// Get peer count
    pub fn peer_count(&self) -> usize {
        self.peers.len()
    }
    
    /// Main event loop
    async fn run_event_loop(&mut self) -> Result<()> {
        while self.running {
            tokio::select! {
                event = self.swarm.select_next_some() => {
                    self.handle_swarm_event(event).await?;
                }
                
                // Handle shutdown signal
                _ = tokio::signal::ctrl_c() => {
                    info!("Received shutdown signal");
                    break;
                }
            }
        }
        
        Ok(())
    }
    
    /// Handle swarm events
    async fn handle_swarm_event(
        &mut self,
        event: SwarmEvent<P2PoolBehaviourEvent>,
    ) -> Result<()> {
        match event {
            SwarmEvent::Behaviour(P2PoolBehaviourEvent::Gossipsub(gossipsub::Event::Message {
                propagation_source: peer_id,
                message_id: _,
                message,
            })) => {
                self.handle_gossip_message(peer_id, message).await?;
            }
            
            SwarmEvent::Behaviour(P2PoolBehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
                for (peer_id, multiaddr) in list {
                    info!("Discovered peer: {} at {}", peer_id, multiaddr);
                    self.swarm.behaviour_mut().kademlia.add_address(&peer_id, multiaddr);
                }
            }
            
            SwarmEvent::Behaviour(P2PoolBehaviourEvent::Ping(ping::Event { peer, result })) => {
                match result {
                    Ok(ping::Success::Ping { rtt }) => {
                        debug!("Ping to {} successful: {:?}", peer, rtt);
                    }
                    Ok(ping::Success::Pong) => {
                        debug!("Pong from {}", peer);
                    }
                    Err(ping::Failure::Timeout) => {
                        warn!("Ping to {} timed out", peer);
                    }
                    Err(ping::Failure::Other { error }) => {
                        warn!("Ping to {} failed: {}", peer, error);
                    }
                }
            }
            
            SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                info!("Connected to peer: {}", peer_id);
                let peer = Peer::new(peer_id.to_string(), "unknown".to_string(), 0);
                self.peers.insert(peer_id, peer.clone());
                let _ = self.event_sender.send(P2PoolEvent::PeerConnected(peer_id.to_string()));
            }
            
            SwarmEvent::ConnectionClosed { peer_id, .. } => {
                info!("Disconnected from peer: {}", peer_id);
                self.peers.remove(&peer_id);
                let _ = self.event_sender.send(P2PoolEvent::PeerDisconnected(peer_id.to_string()));
            }
            
            SwarmEvent::NewListenAddr { address, .. } => {
                info!("Listening on: {}", address);
            }
            
            _ => {}
        }
        
        Ok(())
    }
    
    /// Handle gossipsub messages
    async fn handle_gossip_message(
        &mut self,
        peer_id: LibP2PPeerId,
        message: gossipsub::Message,
    ) -> Result<()> {
        let network_message: NetworkMessage = serde_json::from_slice(&message.data)
            .map_err(|e| Error::network(format!("Deserialize error: {}", e)))?;
        
        match network_message {
            NetworkMessage::ShareAnnouncement(share) => {
                debug!("Received share from {}: {}", peer_id, share.id);
                let _ = self.event_sender.send(P2PoolEvent::ShareReceived(share.id));
            }
            
            NetworkMessage::BlockAnnouncement(block) => {
                info!("Received block from {}: {}", peer_id, block.hash);
                let _ = self.event_sender.send(P2PoolEvent::BlockFound(block.hash));
            }
            
            NetworkMessage::PeerRequest => {
                // Respond with known peers
                let peers = self.get_peers();
                let response = NetworkMessage::PeerResponse(peers);
                // TODO: Send response back to requesting peer
            }
            
            NetworkMessage::PeerResponse(peers) => {
                debug!("Received {} peers from {}", peers.len(), peer_id);
                // TODO: Add peers to our peer list
            }
            
            NetworkMessage::StatusRequest => {
                // Respond with our status
                let status = NetworkStatus {
                    peer_count: self.peer_count(),
                    hash_rate: 0, // TODO: Calculate from shares
                    last_block_height: 0, // TODO: Track latest block
                    version: crate::VERSION.to_string(),
                };
                let response = NetworkMessage::StatusResponse(status);
                // TODO: Send response back to requesting peer
            }
            
            NetworkMessage::StatusResponse(status) => {
                debug!("Received status from {}: {} peers", peer_id, status.peer_count);
            }
        }
        
        Ok(())
    }
    
    /// Get next event from the network
    pub async fn next_event(&mut self) -> Option<P2PoolEvent> {
        self.event_receiver.recv().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_network_creation() {
        let config = NetworkConfig::default();
        let network = P2PNetwork::new(config).await;
        assert!(network.is_ok());
    }
}
