import hre, { network } from "hardhat";
import { deploy } from "../deployUtils.ts";

const HUMA_OWNER_ADDRESS = "0xABd48A580F66ad5Ad0Fe983968De686F408c88EE";
let deployer;
let networkName;

async function deployImplementationContracts() {
    const contracts = [
        // "PoolConfig",
        // "PoolFeeManager",
        // "PoolSafe",
        // "FirstLossCover",
        // "RiskAdjustedTranchesPolicy",
        // "FixedSeniorYieldTranchesPolicy",
        // "Pool",
        // "EpochManager",
        // "TrancheVault",
        // "CreditLine",
        "ReceivableBackedCreditLine",
        // "ReceivableFactoringCredit",
        // "CreditDueManager",
        // "CreditLineManager",
        // "ReceivableBackedCreditLineManager",
        // "ReceivableFactoringCreditManager",
        // "Receivable",
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
        [HUMA_OWNER_ADDRESS],
        [deployer.address],
        deployer.address,
    ]);

    return humaConfig.address;
}

async function deployPoolConfigOne() {
    const Contract = await hre.ethers.getContractFactory("PoolConfig");

    const poolConfigImpl = Contract.attach("0x0da01955AB786a948A6F34317c3beE47c804ad4F");

    const fragment = await poolConfigImpl.interface.getFunction("initialize(string,address[])");
    const calldata = await poolConfigImpl.interface.encodeFunctionData(fragment, [
        "Arf 6 month pool",
        [
            "0x1691090fb0cFd3bd9b59128b57490eA882A09573",
            "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4",
            "0x0562e6287dd69E76771E046f7E24ADC608c837b6",
            "0x1900e417869691277cfd20f4001b768B03375272",
            "0xD6C357c40731a1F57173231eeeAb004eD8baE9b6",
            "0xF1c6661dAd77F50D9Da9199b0705733Cd174f9f1",
            "0xf6C0018bE7F400f77996096C56A3721301fE6620", //tranchesPolicy
            "0x648186Cf2a78AB9356C82ec29EDA42798453C8d6",
            "0xDe5eD603A376B93817b9656AF6E373218fD9b2bd",
            "0x8413a7345cD8bF8Afe8c2EfE866a764A93B305e2",
            "0x2e3A03C8Bd31300C2c027C9C9d1b762677F6FaA6",
            "0xd92950BAe0582620106E1D6ed67a708fF3Eee08F",
            "0xbC015F64b023d8B351484342d35dA0AF0d42a9de",
        ],
    ]);
    await deploy(networkName, "ERC1967Proxy", "PoolConfig6Month", [
        poolConfigImpl.address,
        calldata,
    ]);
}

async function deployPoolConfigTwo() {
    const Contract = await hre.ethers.getContractFactory("PoolConfig");

    const poolConfigImpl = Contract.attach("0x0da01955AB786a948A6F34317c3beE47c804ad4F");

    const fragment = await poolConfigImpl.interface.getFunction("initialize(string,address[])");
    const calldata = await poolConfigImpl.interface.encodeFunctionData(fragment, [
        "Arf 3 month pool",
        [
            "0x1691090fb0cFd3bd9b59128b57490eA882A09573",
            "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4",
            "0x0562e6287dd69E76771E046f7E24ADC608c837b6",
            "0x5227254a6aCa397e95F310b52f6D3143A5A9Ee14",
            "0x7F4f55fAeE753D8dbB3E5F04861dB38E9DB70c3D",
            "0xDD7FB0B032Fa571c1B65EDE318c1142297ED7AE7",
            "0x13d8446B1b365d53B0696947fa96624b5CE19bf3",
            "0x1a2C87Be5e785493310526faA7739Bbe4E10c0F6",
            "0x4cdCedcF50266aD9ed809048BC9874320EC902bC",
            "0x483D02C11f8F1E31C267040A6C86AaB80c428BaB",
            "0xc6F10af4746784a0DD095f4E5718d53ff94eB4a0",
            "0x2e906F96918eDBBeAe8a204FAD1E8F71376E3345",
            "0x061411d05074Bc974f814AC86309D2204f4c265d",
        ],
    ]);
    await deploy(networkName, "ERC1967Proxy", "PoolConfig3Month", [
        poolConfigImpl.address,
        calldata,
    ]);
}

async function deployTranchesPolicy() {
    const Contract = await hre.ethers.getContractFactory("FixedSeniorYieldTranchesPolicy");

    const Impl = Contract.attach("0x941687792107eaC859B820d1636936382F3189aa");

    const fragment = await Impl.interface.getFunction("initialize(address)");
    const calldata = await Impl.interface.encodeFunctionData(fragment, [
        "0xEb78F0fB18f417b7b71E0Ee8391d2aA57069810f",
    ]);

    await deploy(networkName, "ERC1967Proxy", "FixedSeniorYieldTranchesPolicy", [
        Impl.address,
        calldata,
    ]);
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

    await deploy(networkName, "MockToken", "MockToken");
    const humaConfigAddress = await deployProtocolContracts();
    await deployImplementationContracts();
    // await deployFactory(humaConfigAddress);
    // await deployPoolConfigOne();
    // await deployPoolConfigTwo();
    await deployTranchesPolicy();
}

deployContracts()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
