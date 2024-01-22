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
const mumbaiUrl = process.env["MUMBAI_URL"];
const defaultDeployer = process.env["DEPLOYER"];
const protocolOwner = process.env["PROTOCOL_OWNER"];
const treasury = process.env["TREASURY"];
const eaServiceAccount = process.env["EA_SERVICE"];
const pdsServiceAccount = process.env["PDS_SERVICE"];
const poolOwner = process.env["POOL_OWNER"];
const poolOwnerTreasury = process.env["BASE_CREDIT_POOL_OWNER_TREASURY"];
const evaluationAgent = process.env["EA"];
const poolOperator = process.env["BASE_CREDIT_POOL_OPERATOR"];
const seniorLender = process.env["SENIOR_LENDER"];
const juniorLender = process.env["JUNIOR_LENDER"];

const config: HardhatUserConfig = {
    networks: {
        hardhat: {
            chainId: Number(process.env.LOCALHOST_CHAIN_ID ?? 31337),
        },
        sepolia: {
            url: sepoliaUrl,
            accounts: [
                defaultDeployer!,
                protocolOwner!,
                treasury!,
                eaServiceAccount!,
                pdsServiceAccount!,
                poolOwner!,
                poolOwnerTreasury!,
                evaluationAgent!,
                poolOperator!,
                seniorLender!,
                juniorLender!,
            ],
        },
        maticmum: {
            url: mumbaiUrl,
            accounts: [
                defaultDeployer!,
                protocolOwner!,
                treasury!,
                eaServiceAccount!,
                pdsServiceAccount!,
                poolOwner!,
                poolOwnerTreasury!,
                evaluationAgent!,
                poolOperator!,
                seniorLender!,
                juniorLender!,
            ],
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
            polygonMumbai: process.env.POLYGONSCAN_API_KEY!,
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
