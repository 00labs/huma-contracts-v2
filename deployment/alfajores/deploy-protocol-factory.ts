import hre from "hardhat";
import { deploy } from "../deployUtils.ts";

const HUMA_OWNER_ADDRESS = "0x18A00C3cdb71491eF7c3b890f9df37CB5Ec11D2A";
let deployer;

async function deployImplementationContracts() {
    const contracts = [
        "PoolConfig",
        "PoolFeeManager",
        "PoolSafe",
        "FirstLossCover",
        "RiskAdjustedTranchesPolicy",
        "FixedSeniorYieldTranchePolicy",
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

    for (var contractName of contracts) {
        console.log(contractName);
        await deploy(contractName, `${contractName}Impl`);
    }
}

async function deployFactory() {
    const libTimelockController = await deploy("LibTimelockController", "LibTimelockController");
    await deploy("PoolFactory", "PoolFactory", [], {
        libraries: { LibTimelockController: libTimelockController.address },
    });
}

async function deployProtocolContracts() {
    await deploy("EvaluationAgentNFT", "EANFT", []);

    const humaConfig = await deploy("HumaConfig", "HumaConfig");
    console.log(HUMA_OWNER_ADDRESS);
    console.log(deployer.address);
    await deploy("TimelockController", "HumaConfigTimelock", [
        0,
        [HUMA_OWNER_ADDRESS],
        [deployer.address],
        deployer.address,
    ]);
}

async function deployContracts() {
    const network = (await hre.ethers.provider.getNetwork()).name;
    console.log("network : ", network);
    const accounts = await hre.ethers.getSigners();
    if (accounts.length == 0) {
        throw new Error("Accounts not set!");
    }
    [deployer] = await accounts;
    console.log("deployer address: " + deployer.address);

    await deploy("MockToken", "MockToken");
    await deployProtocolContracts();
    await deployImplementationContracts();
    await deployFactory();
}

deployContracts()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
