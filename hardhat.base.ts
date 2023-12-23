import "@nomicfoundation/hardhat-toolbox";
import "hardhat-abi-exporter";
import "hardhat-contract-sizer";

import "dotenv/config";
import { HardhatUserConfig } from "hardhat/types";

const EMPTY_URL = "empty url";
const EMPTY_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000";

let sepoliaUrl = process.env["SEPOLIA_URL"];
if (!sepoliaUrl) {
    sepoliaUrl = EMPTY_URL;
}

let deployer = process.env["DEPLOYER"];
if (!deployer) {
    deployer = EMPTY_PRIVATE_KEY;
}

const config: HardhatUserConfig = {
    solidity: {
        compilers: [
            {
                version: "0.8.18",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
        ],
    },
    networks: {
        sepolia: {
            url: sepoliaUrl,
            accounts: [deployer],
        },
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
