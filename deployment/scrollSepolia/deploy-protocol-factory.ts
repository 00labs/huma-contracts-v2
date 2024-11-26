import hre, { network } from "hardhat";
import { deploy } from "../deployUtils.ts";

const HUMA_OWNER_ADDRESS = "0x60891b087E81Ee2a61B7606f68019ec112c539B9";
let deployer;
let networkName;

async function deployImplementationContracts() {
    const contracts = [
        "PoolConfig",
        // "PoolFeeManager",
        // "PoolSafe",
        // "FirstLossCover",
        // "RiskAdjustedTranchesPolicy",
        // "FixedSeniorYieldTranchesPolicy",
        // "Pool",
        // "EpochManager",
        // "TrancheVault",
        // "CreditLine",
        // "ReceivableBackedCreditLine",
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

async function deployPoolConfig() {
    const Contract = await hre.ethers.getContractFactory("PoolConfig");

    const poolConfigImpl = Contract.attach("0x50459F6AD2B001b6420d732C36e19a1C121f4bd1");

    const fragment = await poolConfigImpl.interface.getFunction("initialize(string,address[])");
    const calldata = await poolConfigImpl.interface.encodeFunctionData(fragment, [
        "3 month credit pool",
        [
            "0xa0A16038D714F687679732dCb34e1d4051218Dc5",
            "0x50dc34a634F3E29CfBad79E9cECD2759a6bA8Eae",
            "0xb94879541CAF746bFe1b066421E7D64C94fC9738",
            "0xA457970f2d9f0EDaaf027cD581336235c9E5A669",
            "0x055AA17ed23AdE6e4437f6259DF2FF1440d2D7ed",
            "0xE9F7d3deb6d3b6D0a4CD19B50690cCB7a654F2F9",
            "0x8Ac431d7E37ed7A2Fefa5E9f14d05163dF1E4B17",
            "0x2c98920D37B771868a19bDC05780623867B3727A",
            "0xdead56d2e3f64BB340aCc6245007F624639d1306",
            "0x9D89D7b88FcC18f0B188978eC46Bbac6b275F69b",
            "0x2c289b61c92Dfaf2be5968fd6367ab32AC4AD26f",
            "0x460b59d033421931Ad61bd7B29EA135D40edc158",
            "0xb455B4BFcA6cFA9873D90FfAdA43369009e14fd2",
        ],
    ]);
    await deploy(networkName, "ERC1967Proxy", "PoolConfig", [poolConfigImpl.address, calldata]);
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
    // const humaConfigAddress = await deployProtocolContracts();
    // await deployImplementationContracts();
    await deployPoolConfig();
    // await deployFactory(humaConfigAddress);
}

deployContracts()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
