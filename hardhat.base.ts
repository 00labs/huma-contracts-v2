import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";
import "hardhat-abi-exporter";
import "hardhat-contract-sizer";

import "dotenv/config";
import { HardhatUserConfig } from "hardhat/types";

// Hardhat tasks
import "./tasks/advance-epoch";
import "./tasks/advance-week-and-drawdown-receivable";
import "./tasks/prepare-tranches-flc-for-withdrawal";
import "./tasks/withdraw-from-tranches";

const EMPTY_URL = "empty url";
const EMPTY_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000";

const sepoliaUrl = process.env["SEPOLIA_URL"] || EMPTY_URL;
const deployer = process.env["DEPLOYER"] || EMPTY_PRIVATE_KEY;

const config: HardhatUserConfig = {
    networks: {
        hardhat: {
            chainId: Number(process.env.LOCALHOST_CHAIN_ID ?? 31337),
            accounts: process.env.LOCALHOST_MNEMONIC_PHRASE
                ? {
                      mnemonic: process.env.LOCALHOST_MNEMONIC_PHRASE,
                  }
                : undefined,
        },
        sepolia: {
            url: sepoliaUrl,
            accounts: [deployer],
        },
        alfajores: {
            url: "https://alfajores-forno.celo-testnet.org",
            accounts: [deployer],
            chainId: 44787,
        },
        celo: {
            url: "https://forno.celo.org",
            accounts: [deployer],
            chainId: 42220,
        },
        baseSepolia: {
            url: "https://sepolia.base.org",
            accounts: [deployer],
            chainId: 84532,
        },
    },
    solidity: {
        compilers: [
            {
                version: "0.8.23",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
        ],
    },
    etherscan: {
        apiKey: {
            sepolia: process.env.ETHERSCAN_API_KEY || "",
            alfajores: process.env.CELOSCAN_API_KEY || "",
            celo: process.env.CELOSCAN_API_KEY || "",
            baseSepolia: process.env.BASESCAN_API_KEY || "",
        },
        customChains: [
            {
                network: "celo",
                chainId: 42220,
                urls: {
                    apiURL: "https://api.celoscan.io/api",
                    browserURL: "https://celoscan.io/",
                },
            },
            {
                network: "alfajores",
                chainId: 44787,
                urls: {
                    apiURL: "https://api-alfajores.celoscan.io/api",
                    browserURL: "https://alfajores.celoscan.io/",
                },
            },
            {
                network: "baseSepolia",
                chainId: 84532,
                urls: {
                    apiURL: "https://api-sepolia.basescan.org/api",
                    browserURL: "https://sepolia.basescan.org/",
                },
            },
        ],
    },
    contractSizer: {
        alphaSort: true,
        disambiguatePaths: false,
        runOnCompile: true,
        strict: true,
    },
    /**
     * gas reporter configuration that lets you know
     * an estimate of gas for contract deployments and function calls
     * More here: https://www.npmjs.com/package/hardhat-gas-reporter
     */
    gasReporter: {
        enabled: true,
        currency: "USD",
        // coinmarketcap: process.env.COINMARKETCAP || null,
    },
    abiExporter: {
        path: "./abi",
        runOnCompile: true,
        clear: true,
        flat: true,
        only: [],
        except: ["ITrancheVaultLike"],
        spacing: 2,
        pretty: false,
    },
};

export default config;
