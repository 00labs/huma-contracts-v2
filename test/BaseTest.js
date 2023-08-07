const {BigNumber: BN} = require("ethers");

function toBN(number, decimals) {
    return BN.from(number).mul(BN.from(10).pow(BN.from(decimals)));
}

function toToken(number, decimals = 6) {
    return toBN(number, decimals);
}

async function deployContracts(
    protocolOwner,
    treasury,
    eaServiceAccount,
    pdsServiceAccount,
    poolOwner
) {
    // Deploy EvaluationAgentNFT
    const EvaluationAgentNFT = await ethers.getContractFactory("EvaluationAgentNFT");
    let eaNFTContract = await EvaluationAgentNFT.deploy();
    await eaNFTContract.deployed();

    // Deploy HumaConfig
    const HumaConfig = await ethers.getContractFactory("HumaConfig");
    let humaConfigContract = await HumaConfig.deploy();
    await humaConfigContract.deployed();

    await humaConfigContract.setHumaTreasury(treasury.address);
    await humaConfigContract.setTreasuryFee(2000);
    await humaConfigContract.setEANFTContractAddress(eaNFTContract.address);
    await humaConfigContract.setEAServiceAccount(eaServiceAccount.address);
    await humaConfigContract.setPDSServiceAccount(pdsServiceAccount.address);

    await humaConfigContract.addPauser(protocolOwner.address);
    await humaConfigContract.addPauser(poolOwner.address);

    await humaConfigContract.transferOwnership(protocolOwner.address);
    if (await humaConfigContract.connect(protocolOwner).paused())
        await humaConfigContract.connect(protocolOwner).unpause();

    const MockToken = await ethers.getContractFactory("MockToken");
    mockTokenContract = await MockToken.deploy();
    await mockTokenContract.deployed();

    await humaConfigContract
        .connect(protocolOwner)
        .setLiquidityAsset(mockTokenContract.address, true);

    return [eaNFTContract, humaConfigContract, mockTokenContract];
}

async function deployAndSetupPool(
    humaConfigContract,
    mockTokenContract,
    eaNFTContract,
    TranchesPolicyContractName,
    deployer,
    poolOwner,
    evaluationAgent
) {
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const poolConfig = await PoolConfig.deploy();
    await poolConfig.deployed();

    const PlatformFeeManager = await ethers.getContractFactory("PlatformFeeManager");
    const platformFeeManager = await PlatformFeeManager.deploy(poolConfig.address);
    await platformFeeManager.deployed();

    const PoolVault = await ethers.getContractFactory("PoolVault");
    const poolVault = await PoolVault.deploy(poolConfig.address);
    await poolVault.deployed();

    const LossCoverer = await ethers.getContractFactory("LossCoverer");
    const lossCoverer = await LossCoverer.deploy(poolConfig.address);
    await lossCoverer.deployed();

    const TranchesPolicy = await ethers.getContractFactory(TranchesPolicyContractName);
    const tranchesPolicy = await TranchesPolicy.deploy(poolConfig.address);
    await tranchesPolicy.deployed();

    const Pool = await ethers.getContractFactory("Pool");
    const pool = await Pool.deploy(poolConfig.address);
    await pool.deployed();

    const EpochManager = await ethers.getContractFactory("EpochManager");
    const epochManager = await EpochManager.deploy(poolConfig.address);
    await epochManager.deployed();

    const TrancheVault = await ethers.getContractFactory("TrancheVault");
    const seniorTrancheVault = await TrancheVault.deploy();
    await seniorTrancheVault.deployed();
    const juniorTrancheVault = await TrancheVault.deploy();
    await juniorTrancheVault.deployed();

    const Calendar = await ethers.getContractFactory("Calendar");
    const calendar = await Calendar.deploy();
    await calendar.deployed();

    const MockCredit = await ethers.getContractFactory("MockCredit");
    const mockCredit = await MockCredit.deploy();
    await mockCredit.deployed();

    await poolConfig.initialize("Test Pool", [
        humaConfigContract.address,
        mockTokenContract.address,
        platformFeeManager.address,
        poolVault.address,
        calendar.address,
        lossCoverer.address,
        tranchesPolicy.address,
        pool.address,
        epochManager.address,
        seniorTrancheVault.address,
        juniorTrancheVault.address,
        mockCredit.address,
    ]);

    await poolConfig.grantRole(await poolConfig.DEFAULT_ADMIN_ROLE(), poolOwner.address);
    await poolConfig.renounceRole(await poolConfig.DEFAULT_ADMIN_ROLE(), deployer.address);

    await platformFeeManager.connect(poolOwner).updatePoolConfigData();
    await poolVault.connect(poolOwner).updatePoolConfigData();
    await lossCoverer.connect(poolOwner).updatePoolConfigData();
    await pool.connect(poolOwner).updatePoolConfigData();
    await epochManager.connect(poolOwner).updatePoolConfigData();
    await seniorTrancheVault
        .connect(poolOwner)
        .initialize("Senior Tranche Vault", "STV", poolConfig.address, 0);
    await juniorTrancheVault
        .connect(poolOwner)
        .initialize("Junior Tranche Vault", "JTV", poolConfig.address, 1);

    return [
        poolConfig,
        platformFeeManager,
        poolVault,
        calendar,
        lossCoverer,
        tranchesPolicy,
        pool,
        epochManager,
        seniorTrancheVault,
        juniorTrancheVault,
        mockCredit,
    ];
}

module.exports = {
    deployContracts,
    deployAndSetupPool,
};
