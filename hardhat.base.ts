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
        },
        sepolia: {
            url: sepoliaUrl,
            accounts: [deployer],
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
        },
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
