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
    mockTokenContract,
    eaNFTContract,
    humaConfigContract,
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
}

async function deployAndSetupPool(
    poolOwner,
    proxyOwner,
    evaluationAgent,
    lender,
    humaConfigContract,
    feeManagerContract,
    testTokenContract,
    principalRateInBps,
    eaNFTContract,
    isReceivableContractFlag,
    poolOperator,
    poolOwnerTreasury
) {
    await testTokenContract.mint(lender.address, toToken(10_000_000));
    await testTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
    await testTokenContract.mint(evaluationAgent.address, toToken(10_000_000));

    await feeManagerContract.connect(poolOwner).setMinPrincipalRateInBps(principalRateInBps);

    const TransparentUpgradeableProxy = await ethers.getContractFactory(
        "TransparentUpgradeableProxy"
    );

    const HDT = await ethers.getContractFactory("HDT");
    const hdtImpl = await HDT.deploy();
    await hdtImpl.deployed();
    const hdtProxy = await TransparentUpgradeableProxy.deploy(
        hdtImpl.address,
        proxyOwner.address,
        []
    );
    await hdtProxy.deployed();
    hdtContract = HDT.attach(hdtProxy.address);
    await hdtContract.initialize("Base Credit HDT", "CHDT", testTokenContract.address);

    const BasePoolConfig = await ethers.getContractFactory("BasePoolConfig");
    const poolConfig = await BasePoolConfig.deploy();
    await poolConfig.deployed();
    await poolConfig.initialize(
        "Base Credit Pool",
        hdtContract.address,
        humaConfigContract.address,
        feeManagerContract.address
    );

    // Deploy pool contract
    let poolContractFactory;
    if (isReceivableContractFlag)
        poolContractFactory = await ethers.getContractFactory("ReceivableFactoringPool");
    else poolContractFactory = await ethers.getContractFactory("BaseCreditPool");

    const poolImpl = await poolContractFactory.deploy();
    //const BaseCreditPool = await ethers.getContractFactory("BaseCreditPool");
    //const poolImpl = await BaseCreditPool.deploy();
    await poolImpl.deployed();
    const poolProxy = await TransparentUpgradeableProxy.deploy(
        poolImpl.address,
        proxyOwner.address,
        []
    );
    await poolProxy.deployed();

    const poolContract = poolContractFactory.attach(poolProxy.address);
    await poolContract.initialize(poolConfig.address);
    await poolContract.deployed();

    await poolConfig.setPool(poolContract.address);
    await hdtContract.setPool(poolContract.address);

    // Pool setup
    await poolConfig.transferOwnership(poolOwner.address);

    // Config rewards and requirements for poolOwner and EA, make initial deposit, and enable pool
    await poolConfig.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000_000));
    await poolConfig.connect(poolOwner).setPoolOwnerRewardsAndLiquidity(625, 10);

    let eaNFTTokenId;
    // Mint EANFT to the ea
    const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
    const receipt = await tx.wait();
    for (const evt of receipt.events) {
        if (evt.event === "NFTGenerated") {
            eaNFTTokenId = evt.args.tokenId;
        }
    }

    await poolConfig.connect(poolOwner).setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
    let s = await poolConfig.getPoolSummary();

    await poolConfig.connect(poolOwner).setEARewardsAndLiquidity(1875, 10);

    await poolConfig.connect(poolOwner).setPoolOwnerTreasury(poolOwnerTreasury.address);
    await poolConfig.connect(poolOwner).addPoolOperator(poolOwner.address);
    await poolConfig.connect(poolOwner).addPoolOperator(poolOperator.address);

    await poolContract.connect(poolOperator).addApprovedLender(poolOwnerTreasury.address);
    await poolContract.connect(poolOperator).addApprovedLender(evaluationAgent.address);
    await poolContract.connect(poolOperator).addApprovedLender(lender.address);

    await testTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolContract.address, toToken(1_000_000));
    await poolContract.connect(poolOwnerTreasury).makeInitialDeposit(toToken(1_000_000));

    await testTokenContract
        .connect(evaluationAgent)
        .approve(poolContract.address, toToken(2_000_000));
    await poolContract.connect(evaluationAgent).makeInitialDeposit(toToken(2_000_000));

    await expect(poolContract.connect(poolOwner).enablePool()).to.emit(
        poolContract,
        "PoolEnabled"
    );

    await poolConfig.connect(poolOwner).setAPR(1217);
    await poolConfig.connect(poolOwner).setMaxCreditLine(toToken(10_000_000));

    await testTokenContract.connect(lender).approve(poolContract.address, toToken(2_000_000));
    await poolContract.connect(lender).deposit(toToken(2_000_000));

    return [hdtContract, poolConfig, poolContract, poolImpl, poolProxy];
}

module.exports = {
    deployContracts,
    deployAndSetupPool,
};
