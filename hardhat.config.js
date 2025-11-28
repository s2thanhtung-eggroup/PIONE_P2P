require("@nomicfoundation/hardhat-toolbox");
require("hardhat-contract-sizer");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const INFURA_KEY = process.env.INFURA_KEY || "";
const EXPLORER_API_KEY = process.env.EXPLORER_API_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      {
        version: "0.8.4",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ]
  },
  networks: {
    pione: {
      url: "https://rpc.pionescan.com",
      chainId: 5090,
      accounts: [PRIVATE_KEY]
    },
    pioneZero: {
      url: "https://rpc.zeroscan.org",
      chainId: 5080,
      accounts: [PRIVATE_KEY]
    },
    bscTestnet: {
      url: `https://bsc-testnet.infura.io/v3/${INFURA_KEY}`,
      accounts: [PRIVATE_KEY], 
      chainId: 97,
    },
    bsc: {
      url: `https://bsc-mainnet.infura.io/v3/${INFURA_KEY}`,
      accounts: [PRIVATE_KEY],
      chainId: 56,
    }
  },
  etherscan: {
    // apiKey: EXPLORER_API_KEY,
    apiKey: {
      pione: EXPLORER_API_KEY,
    },
    customChains: [
      {
        network: "pione",
        chainId: 5090,
        urls: {
          apiURL: "https://pionescan.com/api/",
          browserURL: "https://pionescan.com/",
        },
      },
      {
        network: "pioneZero",
        chainId: 5080,
        urls: {
          apiURL: "https://zeroscan.org/api/",
          browserURL: "https://zeroscan.org/",
        },
      },
    ]
  },
};
