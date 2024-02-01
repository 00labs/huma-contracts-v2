import hre from "hardhat";
import { deploy } from "../deployUtils.ts";

const HUMA_OWNER_ADDRESS = "0x18A00C3cdb71491eF7c3b890f9df37CB5Ec11D2A";
let deployer;
const network = "baseSepolia";

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
        await deploy(network, contractName, `${contractName}Impl`);
    }
}

async function deployFactory(humaConfigAddress) {
    const libTimelockController = await deploy(
        network,
        "LibTimelockController",
        "LibTimelockController",
    );
    const poolFactoryImpl = await deploy(network, "PoolFactory", "PoolFactoryImpl", [], {
        libraries: { LibTimelockController: libTimelockController.address },
    });
    console.log(humaConfigAddress);
    const fragment = await poolFactoryImpl.interface.getFunction("initialize(address)");
    const calldata = await poolFactoryImpl.interface.encodeFunctionData(fragment, [
        humaConfigAddress,
    ]);
    await deploy(network, "ERC1967Proxy", "PoolFactory", [poolFactoryImpl.address, calldata]);
}

async function deployProtocolContracts() {
    await deploy(network, "EvaluationAgentNFT", "EANFT");
    await deploy(network, "Calendar", "Calendar");
    const humaConfig = await deploy(network, "HumaConfig", "HumaConfig");
    await deploy(network, "TimelockController", "HumaConfigTimelock", [
        0,
        [HUMA_OWNER_ADDRESS],
        [deployer.address],
        deployer.address,
    ]);

    return humaConfig.address;
}

async function deployContracts() {
    // const network = (await hre.ethers.provider.getNetwork()).name;

    console.log("network : ", network);
    const accounts = await hre.ethers.getSigners();
    if (accounts.length == 0) {
        throw new Error("Accounts not set!");
    }
    [deployer] = await accounts;
    console.log("deployer address: " + deployer.address);

    await deploy(network, "MockToken", "MockToken");
    const humaConfigAddress = await deployProtocolContracts();
    await deployImplementationContracts();
    await deployFactory(humaConfigAddress);
}

deployContracts()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
