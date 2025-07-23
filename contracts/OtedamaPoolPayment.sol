// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

/**
 * @title OtedamaPoolPayment
 * @dev Smart contract for managing mining pool payments
 */
contract OtedamaPoolPayment is Ownable, Pausable, ReentrancyGuard {
    using SafeMath for uint256;
    
    // Events
    event PaymentSent(address indexed miner, uint256 amount, uint256 timestamp);
    event BatchPaymentSent(uint256 count, uint256 totalAmount, uint256 timestamp);
    event MinimumPayoutUpdated(uint256 oldAmount, uint256 newAmount);
    event EmergencyWithdrawal(address indexed to, uint256 amount);
    event SharesRecorded(address indexed miner, uint256 shares, uint256 difficulty);
    
    // Miner data structure
    struct MinerData {
        uint256 pendingPayment;
        uint256 totalPaid;
        uint256 totalShares;
        uint256 lastPaymentTime;
        bool isActive;
    }
    
    // State variables
    mapping(address => MinerData) public miners;
    mapping(address => bool) public operators;
    
    uint256 public minimumPayout = 0.001 ether;
    uint256 public totalPayments;
    uint256 public totalVolume;
    uint256 public poolFeePercentage = 100; // 1% = 100 basis points
    address public feeRecipient;
    
    // Payment queue
    address[] public paymentQueue;
    mapping(address => bool) public inQueue;
    
    // Statistics
    uint256 public totalMiners;
    uint256 public activeMiners;
    
    // Modifiers
    modifier onlyOperator() {
        require(operators[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }
    
    modifier validAddress(address _address) {
        require(_address != address(0), "Invalid address");
        _;
    }
    
    constructor(address _feeRecipient) {
        feeRecipient = _feeRecipient;
        operators[msg.sender] = true;
    }
    
    /**
     * @dev Add shares for a miner
     */
    function addShares(
        address _miner,
        uint256 _shares,
        uint256 _difficulty
    ) external onlyOperator validAddress(_miner) {
        MinerData storage miner = miners[_miner];
        
        if (!miner.isActive) {
            miner.isActive = true;
            totalMiners++;
            activeMiners++;
        }
        
        miner.totalShares = miner.totalShares.add(_shares);
        
        emit SharesRecorded(_miner, _shares, _difficulty);
    }
    
    /**
     * @dev Add pending payment for a miner
     */
    function addPendingPayment(
        address _miner,
        uint256 _amount
    ) external onlyOperator validAddress(_miner) {
        require(_amount > 0, "Amount must be greater than 0");
        
        MinerData storage miner = miners[_miner];
        miner.pendingPayment = miner.pendingPayment.add(_amount);
        
        // Add to payment queue if minimum reached
        if (miner.pendingPayment >= minimumPayout && !inQueue[_miner]) {
            paymentQueue.push(_miner);
            inQueue[_miner] = true;
        }
    }
    
    /**
     * @dev Pay a single miner
     */
    function payMiner(address _miner, uint256 _amount) 
        external 
        onlyOperator 
        nonReentrant 
        whenNotPaused 
    {
        require(_amount > 0, "Amount must be greater than 0");
        require(address(this).balance >= _amount, "Insufficient pool balance");
        
        MinerData storage miner = miners[_miner];
        
        // Calculate fee
        uint256 fee = _amount.mul(poolFeePercentage).div(10000);
        uint256 netAmount = _amount.sub(fee);
        
        // Update miner data
        if (_amount <= miner.pendingPayment) {
            miner.pendingPayment = miner.pendingPayment.sub(_amount);
        } else {
            miner.pendingPayment = 0;
        }
        
        miner.totalPaid = miner.totalPaid.add(netAmount);
        miner.lastPaymentTime = block.timestamp;
        
        // Transfer funds
        (bool success, ) = _miner.call{value: netAmount}("");
        require(success, "Transfer failed");
        
        // Transfer fee
        if (fee > 0) {
            (bool feeSuccess, ) = feeRecipient.call{value: fee}("");
            require(feeSuccess, "Fee transfer failed");
        }
        
        // Update statistics
        totalPayments++;
        totalVolume = totalVolume.add(_amount);
        
        // Remove from queue if exists
        if (inQueue[_miner]) {
            _removeFromQueue(_miner);
        }
        
        emit PaymentSent(_miner, netAmount, block.timestamp);
    }
    
    /**
     * @dev Batch payment to multiple miners
     */
    function batchPayment(
        address[] calldata _miners,
        uint256[] calldata _amounts
    ) external onlyOperator nonReentrant whenNotPaused {
        require(_miners.length == _amounts.length, "Array length mismatch");
        require(_miners.length > 0, "Empty arrays");
        require(_miners.length <= 100, "Too many payments");
        
        uint256 totalAmount = 0;
        
        // Calculate total amount needed
        for (uint256 i = 0; i < _amounts.length; i++) {
            totalAmount = totalAmount.add(_amounts[i]);
        }
        
        require(address(this).balance >= totalAmount, "Insufficient pool balance");
        
        uint256 successCount = 0;
        uint256 totalPaid = 0;
        
        // Process payments
        for (uint256 i = 0; i < _miners.length; i++) {
            if (_amounts[i] == 0) continue;
            
            address miner = _miners[i];
            uint256 amount = _amounts[i];
            
            MinerData storage minerData = miners[miner];
            
            // Calculate fee
            uint256 fee = amount.mul(poolFeePercentage).div(10000);
            uint256 netAmount = amount.sub(fee);
            
            // Update miner data
            if (amount <= minerData.pendingPayment) {
                minerData.pendingPayment = minerData.pendingPayment.sub(amount);
            } else {
                minerData.pendingPayment = 0;
            }
            
            minerData.totalPaid = minerData.totalPaid.add(netAmount);
            minerData.lastPaymentTime = block.timestamp;
            
            // Transfer funds
            (bool success, ) = miner.call{value: netAmount}("");
            
            if (success) {
                successCount++;
                totalPaid = totalPaid.add(amount);
                
                // Remove from queue if exists
                if (inQueue[miner]) {
                    _removeFromQueue(miner);
                }
                
                emit PaymentSent(miner, netAmount, block.timestamp);
            }
            
            // Transfer fee
            if (fee > 0 && success) {
                (bool feeSuccess, ) = feeRecipient.call{value: fee}("");
                // Continue even if fee transfer fails
            }
        }
        
        // Update statistics
        totalPayments = totalPayments.add(successCount);
        totalVolume = totalVolume.add(totalPaid);
        
        emit BatchPaymentSent(successCount, totalPaid, block.timestamp);
    }
    
    /**
     * @dev Process payment queue
     */
    function processPaymentQueue(uint256 _limit) external onlyOperator {
        uint256 processed = 0;
        uint256 i = 0;
        
        while (i < paymentQueue.length && processed < _limit) {
            address miner = paymentQueue[i];
            MinerData storage minerData = miners[miner];
            
            if (minerData.pendingPayment >= minimumPayout) {
                // Process payment
                uint256 amount = minerData.pendingPayment;
                
                if (address(this).balance >= amount) {
                    // Calculate fee
                    uint256 fee = amount.mul(poolFeePercentage).div(10000);
                    uint256 netAmount = amount.sub(fee);
                    
                    // Transfer funds
                    (bool success, ) = miner.call{value: netAmount}("");
                    
                    if (success) {
                        // Update miner data
                        minerData.pendingPayment = 0;
                        minerData.totalPaid = minerData.totalPaid.add(netAmount);
                        minerData.lastPaymentTime = block.timestamp;
                        
                        // Transfer fee
                        if (fee > 0) {
                            (bool feeSuccess, ) = feeRecipient.call{value: fee}("");
                        }
                        
                        // Update statistics
                        totalPayments++;
                        totalVolume = totalVolume.add(amount);
                        
                        emit PaymentSent(miner, netAmount, block.timestamp);
                        
                        processed++;
                    }
                }
            }
            
            // Remove from queue
            _removeFromQueueAt(i);
        }
    }
    
    /**
     * @dev Update minimum payout
     */
    function setMinimumPayout(uint256 _amount) external onlyOwner {
        require(_amount > 0, "Amount must be greater than 0");
        
        uint256 oldAmount = minimumPayout;
        minimumPayout = _amount;
        
        emit MinimumPayoutUpdated(oldAmount, _amount);
    }
    
    /**
     * @dev Update pool fee
     */
    function setPoolFee(uint256 _feePercentage) external onlyOwner {
        require(_feePercentage <= 1000, "Fee too high"); // Max 10%
        poolFeePercentage = _feePercentage;
    }
    
    /**
     * @dev Update fee recipient
     */
    function setFeeRecipient(address _feeRecipient) 
        external 
        onlyOwner 
        validAddress(_feeRecipient) 
    {
        feeRecipient = _feeRecipient;
    }
    
    /**
     * @dev Add operator
     */
    function addOperator(address _operator) 
        external 
        onlyOwner 
        validAddress(_operator) 
    {
        operators[_operator] = true;
    }
    
    /**
     * @dev Remove operator
     */
    function removeOperator(address _operator) external onlyOwner {
        operators[_operator] = false;
    }
    
    /**
     * @dev Emergency withdrawal
     */
    function emergencyWithdraw(address _to, uint256 _amount) 
        external 
        onlyOwner 
        validAddress(_to) 
    {
        require(_amount <= address(this).balance, "Insufficient balance");
        
        (bool success, ) = _to.call{value: _amount}("");
        require(success, "Transfer failed");
        
        emit EmergencyWithdrawal(_to, _amount);
    }
    
    /**
     * @dev Get miner data
     */
    function getMinerData(address _miner) 
        external 
        view 
        returns (
            uint256 pendingPayment,
            uint256 totalPaid,
            uint256 totalShares,
            uint256 lastPaymentTime,
            bool isActive
        ) 
    {
        MinerData memory miner = miners[_miner];
        return (
            miner.pendingPayment,
            miner.totalPaid,
            miner.totalShares,
            miner.lastPaymentTime,
            miner.isActive
        );
    }
    
    /**
     * @dev Get payment queue length
     */
    function getPaymentQueueLength() external view returns (uint256) {
        return paymentQueue.length;
    }
    
    /**
     * @dev Get contract statistics
     */
    function getStatistics() 
        external 
        view 
        returns (
            uint256 poolBalance,
            uint256 _totalPayments,
            uint256 _totalVolume,
            uint256 _totalMiners,
            uint256 _activeMiners,
            uint256 queueLength
        ) 
    {
        return (
            address(this).balance,
            totalPayments,
            totalVolume,
            totalMiners,
            activeMiners,
            paymentQueue.length
        );
    }
    
    /**
     * @dev Remove miner from payment queue
     */
    function _removeFromQueue(address _miner) private {
        for (uint256 i = 0; i < paymentQueue.length; i++) {
            if (paymentQueue[i] == _miner) {
                _removeFromQueueAt(i);
                break;
            }
        }
    }
    
    /**
     * @dev Remove from queue at index
     */
    function _removeFromQueueAt(uint256 _index) private {
        if (_index >= paymentQueue.length) return;
        
        address miner = paymentQueue[_index];
        inQueue[miner] = false;
        
        // Move last element to deleted position
        if (_index < paymentQueue.length - 1) {
            paymentQueue[_index] = paymentQueue[paymentQueue.length - 1];
        }
        
        paymentQueue.pop();
    }
    
    /**
     * @dev Pause contract
     */
    function pause() external onlyOwner {
        _pause();
    }
    
    /**
     * @dev Unpause contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /**
     * @dev Receive function to accept ETH
     */
    receive() external payable {}
}