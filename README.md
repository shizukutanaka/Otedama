# Otedama - v0.6.0

**Professional P2P Mining Pool & DEX Platform**

Otedama is a high-performance, peer-to-peer cryptocurrency mining pool combined with a decentralized exchange (DEX) platform. This platform is designed for both individual miners and professional operations, offering a robust, low-fee environment for mining and auto-converting various cryptocurrencies directly to Bitcoin.

![Version](https://img.shields.io/badge/version-0.6.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)

**Translate:** [English](https://github.com/otedama/otedama/blob/main/README.md) | [日本語](https://translate.google.com/translate?sl=en&tl=ja&u=https://github.com/otedama/otedama/blob/main/README.md) | [Español](https://translate.google.com/translate?sl=en&tl=es&u=https://github.com/otedama/otedama/blob/main/README.md) | [中文](https://translate.google.com/translate?sl=en&tl=zh-CN&u=https://github.com/otedama/otedama/blob/main/README.md) | [Français](https://translate.google.com/translate?sl=en&tl=fr&u=https://github.com/otedama/otedama/blob/main/README.md) | [Deutsch](https://translate.google.com/translate?sl=en&tl=de&u=https://github.com/otedama/otedama/blob/main/README.md) | [한국어](https://translate.google.com/translate?sl=en&tl=ko&u=https://github.com/otedama/otedama/blob/main/README.md) | [Português](https://translate.google.com/translate?sl=en&tl=pt&u=https://github.com/otedama/otedama/blob/main/README.md) | [Русский](https://translate.google.com/translate?sl=en&tl=ru&u=https://github.com/otedama/otedama/blob/main/README.md) | [العربية](https://translate.google.com/translate?sl=en&tl=ar&u=https://github.com/otedama/otedama/blob/main/README.md) | [हिन्दी](https://translate.google.com/translate?sl=en&tl=hi&u=https://github.com/otedama/otedama/blob/main/README.md)

---

## Key Features (v0.6.0)

*   **P2P Mining Pool:** Decentralized and robust stratum-based mining pool.
*   **Integrated DEX:** Automatically convert mined altcoins to Bitcoin.
*   **BTC-Only Payouts:** Simplify your earnings with payouts exclusively in BTC.
*   **Low Fees:**
    *   **Mining Fee:** 1%
    *   **Conversion Fee:** 0.5%
*   **Multi-Currency Support:** Mine over 13 different cryptocurrencies.
*   **Multi-Language Support:** The platform is available in over 50 languages.
*   **Cross-Platform:** Runs on Windows, macOS, and Linux.
*   **Dockerized:** Easy deployment with Docker and Docker Compose.

## Getting Started

### Prerequisites

*   [Node.js](https://nodejs.org/) (v18.0.0 or higher)
*   [Git](https://git-scm.com/)
*   (Optional) [Docker](https://www.docker.com/)

### Installation

1.  Clone the repository:
    ```sh
    git clone https://github.com/shizukutanaka/Otedama.git
    cd otedama
    ```

2.  Install dependencies:
    ```sh
    npm install
    ```

3.  Run the setup script for your OS:
    *   **Windows:**
        ```bat
        setup.bat
        ```
    *   **Linux/macOS:**
        ```sh
        bash setup.sh
        ```

## Usage

### Running the Application

To start the main application server:

```sh
npm start
```

### Using Docker

For a containerized deployment:

1.  Build the Docker image:
    ```sh
    npm run docker:build
    ```

2.  Run the container using Docker Compose:
    ```sh
    npm run docker:deploy
    ```

## Configuration

Key configuration parameters are defined in `package.json` under the `config` object:

*   **`mining_fee`**: 1% of minimum payout
*   **`conversion_fee`**: 0.5% BTC conversion
*   **`payout_currency`**: BTC only
*   **`supported_currencies`**: 13
*   **`supported_languages`**: 50

## Technology Stack

*   **Backend:** Node.js
*   **Database:** better-sqlite3
*   **Real-time Communication:** ws (WebSocket)

## Project Roadmap

### Phase 1: Market Launch (Q3 2025)
- [ ] Community building and miner onboarding
- [ ] Real-time price feed integration (CoinGecko, CoinMarketCap)
- [ ] Advanced analytics dashboard
- [ ] Referral program implementation

### Phase 2: Feature Enhancement (Q4 2025)
- [ ] Lightning Network integration for instant payouts
- [ ] Advanced DeFi features (yield farming, staking)
- [ ] Mobile app store deployment (iOS/Android)
- [ ] API marketplace and third-party integrations

### Phase 3: Global Expansion (Q1 2026)
- [ ] Regional mining pool nodes for latency optimization
- [ ] Fiat currency integration and off-ramps
- [ ] Enterprise mining farm partnerships
- [ ] Institutional custody integration

### Phase 4: Innovation Leadership (Q2 2026)
- [ ] AI-powered mining optimization
- [ ] Cross-chain compatibility expansion
- [ ] Decentralized governance implementation
- [ ] Carbon-neutral mining initiatives

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
