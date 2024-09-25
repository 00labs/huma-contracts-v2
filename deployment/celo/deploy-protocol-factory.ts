import hre, { network } from "hardhat";
import { deploy } from "../deployUtils.ts";

const HUMA_OWNER_ADDRESS = "0xABd48A580F66ad5Ad0Fe983968De686F408c88EE";
let deployer;
let networkName;

async function deployImplementationContracts() {
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

    for (var contractName of contracts) {
        console.log(contractName);
        await deploy(networkName, contractName, `${contractName}Impl`);
    }
}

async function deployFactory(humaConfigAddress) {
    const libTimelockController = await deploy(
        networkName,
        "LibTimelockController",
        "LibTimelockController",
    );
    const poolFactoryImpl = await deploy(networkName, "PoolFactory", "PoolFactoryImpl", [], {
        libraries: { LibTimelockController: libTimelockController.address },
    });
    console.log(humaConfigAddress);
    const fragment = await poolFactoryImpl.interface.getFunction("initialize(address)");
    const calldata = await poolFactoryImpl.interface.encodeFunctionData(fragment, [
        humaConfigAddress,
    ]);
    await deploy(networkName, "ERC1967Proxy", "PoolFactory", [poolFactoryImpl.address, calldata]);
}

async function deployProtocolContracts() {
    await deploy(networkName, "Calendar", "Calendar");
    const humaConfig = await deploy(networkName, "HumaConfig", "HumaConfig");
    await deploy(networkName, "TimelockController", "HumaConfigTimelock", [
        0,
        [deployer.address],
        [HUMA_OWNER_ADDRESS],
        HUMA_OWNER_ADDRESS,
    ]);

    return humaConfig.address;
}

async function deployContracts() {
    // const networkName = (await hre.ethers.provider.getNetworkName()).name;
    networkName = network.name;
    console.log("networkName : ", networkName);
    const accounts = await hre.ethers.getSigners();
    if (accounts.length == 0) {
        throw new Error("Accounts not set!");
    }
    [deployer] = await accounts;
    console.log("deployer address: " + deployer.address);

    // await deploy(networkName, "MockToken", "MockToken");
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
