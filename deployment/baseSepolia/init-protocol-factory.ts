import hre from "hardhat";
import {
    getDeployedContracts,
    getInitilizedContract,
    sendTransaction,
    updateInitializedContract,
} from "../deployUtils.ts";

const network = "baseSepolia";
let deployer, eaService;
let deployedContracts;
const HUMA_TREASURY_ACCOUNT = "0x18A00C3cdb71491eF7c3b890f9df37CB5Ec11D2A";
const EA_SERVICE_ACCOUNT = "0x18A00C3cdb71491eF7c3b890f9df37CB5Ec11D2A";
const SENTINEL_ACCOUNT = "0xD8F15c96825e1724B18dd477583E0DcCE3DfF0b1";
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
    const initilized = await getInitilizedContract("HumaConfig", network);
    if (initilized) {
        console.log("HumaConfig is already initialized!");
        return;
    }

    if (!deployedContracts["HumaConfig"]) {
        throw new Error("HumaConfig not deployed yet!");
    }

    if (!deployedContracts["EANFT"]) {
        throw new Error("EANFT not deployed yet!");
    }

    if (!deployedContracts["MockToken"]) {
        throw new Error("MockToken not deployed yet!");
    }

    const HumaConfig = await hre.ethers.getContractFactory("HumaConfig");
    const humaConfig = HumaConfig.attach(deployedContracts["HumaConfig"]);

    await sendTransaction("HumaConfig", humaConfig, "setLiquidityAsset", [
        deployedContracts["MockToken"],
    ]);
    // await transferOwnershipToTL("HumaConfig", "HumaConfig", "HumaConfigTimelock")

    await updateInitializedContract("HumaConfig", network);
}

async function initPoolFactory() {
    const initilized = await getInitilizedContract("PoolFactory", network);
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

    await updateInitializedContract("PoolFactory", network);
}

async function initContracts() {
    // const network = (await hre.ethers.provider.getNetwork()).name;
    console.log("network : ", network);
    const accounts = await hre.ethers.getSigners();
    [deployer] = await accounts;
    console.log("deployer address: " + deployer.address);
    // console.log("ea address: " + eaService.address);

    deployedContracts = await getDeployedContracts(network);
    console.log(deployedContracts);
    await initHumaConfig();
    await initPoolFactory();
}

initContracts()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
