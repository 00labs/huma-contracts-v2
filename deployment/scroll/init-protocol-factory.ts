import hre, { network } from "hardhat";
import {
    getDeployedContracts,
    getInitilizedContract,
    sendTransaction,
    updateInitializedContract,
} from "../deployUtils.ts";

let networkName;
let deployer;
let deployedContracts;
const HUMA_TREASURY_ACCOUNT = "0xABd48A580F66ad5Ad0Fe983968De686F408c88EE";
const SENTINEL_ACCOUNT = "0x5F60a64952344018028D977774019845e14e8062";
const contracts = [
    "PoolConfig",
    "PoolFeeManager",
    "PoolSafe",
    "FirstLossCover",
    "RiskAdjustedTranchesPolicy",
    "FixedSeniorYieldTranchesPolicy",
    "Pool",
    "EpochManager",
    "TrancheVault",
    "CreditLine",
    "ReceivableBackedCreditLine",
    "ReceivableFactoringCredit",
    "CreditDueManager",
    "CreditLineManager",
    "ReceivableBackedCreditLineManager",
    "ReceivableFactoringCreditManager",
    "Receivable",
];

async function transferOwnershipToTL(contractName, contractKey, timeLockKey) {
    if (!deployedContracts[timeLockKey]) {
        throw new Error(`${timeLockKey} not deployed yet!`);
    }

    if (!deployedContracts[contractKey]) {
        throw new Error(`${contractKey} not deployed yet!`);
    }

    const TimeLockController = await hre.ethers.getContractFactory("TimelockController");
    const timeLockController = TimeLockController.attach(deployedContracts[timeLockKey]);

    const Contract = await hre.ethers.getContractFactory(contractName);
    const contract = Contract.attach(deployedContracts[contractKey]);

    await sendTransaction(contractKey, contract, "transferOwnership", [
        timeLockController.address,
    ]);

    const adminRole = await timeLockController.TIMELOCK_ADMIN_ROLE();
    await sendTransaction(contractKey, timeLockController, "renounceRole", [
        adminRole,
        deployer.address,
    ]);
}

async function initHumaConfig() {
    const initilized = await getInitilizedContract("HumaConfig", networkName);
    if (initilized) {
        console.log("HumaConfig is already initialized!");
        return;
    }

    if (!deployedContracts["HumaConfig"]) {
        throw new Error("HumaConfig not deployed yet!");
    }

    if (!deployedContracts["MockToken"]) {
        throw new Error("MockToken not deployed yet!");
    }

    const HumaConfig = await hre.ethers.getContractFactory("HumaConfig");
    const humaConfig = HumaConfig.attach(deployedContracts["HumaConfig"]);

    await sendTransaction("HumaConfig", humaConfig, "setHumaTreasury", [HUMA_TREASURY_ACCOUNT]);
    await sendTransaction("HumaConfig", humaConfig, "setSentinelServiceAccount", [
        SENTINEL_ACCOUNT,
    ]);
    await sendTransaction("HumaConfig", humaConfig, "setLiquidityAsset", [
        deployedContracts["MockToken"],
        true,
    ]);
    // await transferOwnershipToTL("HumaConfig", "HumaConfig", "HumaConfigTimelock")

    await updateInitializedContract("HumaConfig", networkName);
}

async function initPoolFactory() {
    const initilized = await getInitilizedContract("PoolFactory", networkName);
    if (initilized) {
        console.log("PoolFactory is already initialized!");
        return;
    }

    if (!deployedContracts["PoolFactory"]) {
        throw new Error("PoolFactory not deployed yet!");
    }

    for (var contractName of contracts) {
        if (!deployedContracts[`${contractName}Impl`]) {
            throw new Error(contractName + " not deployed yet!");
        }
    }

    const PoolFactory = await hre.ethers.getContractFactory("PoolFactory", {
        libraries: { LibTimelockController: deployedContracts["LibTimelockController"] },
    });
    const poolFactory = PoolFactory.attach(deployedContracts["PoolFactory"]);

    await sendTransaction("PoolFactory", poolFactory, "addDeployer", [deployer.address]);
    await sendTransaction("PoolFactory", poolFactory, "setCalendarAddress", [
        deployedContracts["Calendar"],
    ]);
    for (contractName of contracts) {
        await sendTransaction("PoolFactory", poolFactory, `set${contractName}ImplAddress`, [
            deployedContracts[`${contractName}Impl`],
        ]);
    }

    // await transferOwnershipToTL("HumaConfig", "HumaConfig", "HumaConfigTimelock")

    await updateInitializedContract("PoolFactory", networkName);
}

export async function initContracts() {
    // const networkName = (await hre.ethers.provider.getNetworkName()).name;
    networkName = network.name;
    console.log("networkName : ", networkName);
    const accounts = await hre.ethers.getSigners();
    [deployer] = await accounts;
    console.log("deployer address: " + deployer.address);
    // console.log("ea address: " + eaService.address);

    deployedContracts = await getDeployedContracts(networkName);
    console.log(deployedContracts);
    // await initHumaConfig();
    await initPoolFactory();
}

// initContracts()
//     .then(() => process.exit(0))
//     .catch((error) => {
//         console.error(error);
//         process.exit(1);
//     });
