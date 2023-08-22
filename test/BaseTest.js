const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {toToken, getNextDate, getNextMonth} = require("./TestUtils");

const CALENDAR_UNIT_DAY = 0;
const CALENDAR_UNIT_MONTH = 1;
const SENIOR_TRANCHE_INDEX = 0;
const JUNIOR_TRANCHE_INDEX = 1;
const PRICE_DECIMALS_FACTOR = BN.from(10).pow(BN.from(18));

const CONSTANTS = {
    CALENDAR_UNIT_DAY,
    CALENDAR_UNIT_MONTH,
    SENIOR_TRANCHE_INDEX,
    JUNIOR_TRANCHE_INDEX,
    PRICE_DECIMALS_FACTOR,
};

async function deployProtocolContracts(
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

async function deployPoolContracts(
    humaConfigContract,
    mockTokenContract,
    tranchesPolicyContractName,
    deployer,
    poolOwner
) {
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const poolConfigContract = await PoolConfig.deploy();
    await poolConfigContract.deployed();

    const PlatformFeeManager = await ethers.getContractFactory("PlatformFeeManager");
    const platformFeeManagerContract = await PlatformFeeManager.deploy(poolConfigContract.address);
    await platformFeeManagerContract.deployed();

    const PoolVault = await ethers.getContractFactory("PoolVault");
    const poolVaultContract = await PoolVault.deploy(poolConfigContract.address);
    await poolVaultContract.deployed();

    const LossCoverer = await ethers.getContractFactory("LossCoverer");
    const poolOwnerAndEAlossCovererContract = await LossCoverer.deploy(poolConfigContract.address);
    await poolOwnerAndEAlossCovererContract.deployed();

    const TranchesPolicy = await ethers.getContractFactory(tranchesPolicyContractName);
    const tranchesPolicyContract = await TranchesPolicy.deploy(poolConfigContract.address);
    await tranchesPolicyContract.deployed();

    const Pool = await ethers.getContractFactory("Pool");
    const poolContract = await Pool.deploy(poolConfigContract.address);
    await poolContract.deployed();

    const EpochManager = await ethers.getContractFactory("EpochManager");
    const epochManagerContract = await EpochManager.deploy(poolConfigContract.address);
    await epochManagerContract.deployed();

    const TrancheVault = await ethers.getContractFactory("TrancheVault");
    const seniorTrancheVaultContract = await TrancheVault.deploy();
    await seniorTrancheVaultContract.deployed();
    const juniorTrancheVaultContract = await TrancheVault.deploy();
    await juniorTrancheVaultContract.deployed();

    const Calendar = await ethers.getContractFactory("Calendar");
    const calendarContract = await Calendar.deploy();
    await calendarContract.deployed();

    const MockCredit = await ethers.getContractFactory("MockCredit");
    const mockCreditContract = await MockCredit.deploy(poolConfigContract.address);
    await mockCreditContract.deployed();

    await poolConfigContract.initialize("Test Pool", [
        humaConfigContract.address,
        mockTokenContract.address,
        platformFeeManagerContract.address,
        poolVaultContract.address,
        calendarContract.address,
        poolOwnerAndEAlossCovererContract.address,
        tranchesPolicyContract.address,
        poolContract.address,
        epochManagerContract.address,
        seniorTrancheVaultContract.address,
        juniorTrancheVaultContract.address,
        mockCreditContract.address,
    ]);

    await poolConfigContract.grantRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.address
    );
    await poolConfigContract.renounceRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        deployer.address
    );

    await platformFeeManagerContract.connect(poolOwner).updatePoolConfigData();
    await poolVaultContract.connect(poolOwner).updatePoolConfigData();
    await poolOwnerAndEAlossCovererContract.connect(poolOwner).updatePoolConfigData();
    await poolContract.connect(poolOwner).updatePoolConfigData();
    await epochManagerContract.connect(poolOwner).updatePoolConfigData();
    await seniorTrancheVaultContract
        .connect(poolOwner)
        .initialize(
            "Senior Tranche Vault",
            "STV",
            poolConfigContract.address,
            SENIOR_TRANCHE_INDEX
        );
    await juniorTrancheVaultContract
        .connect(poolOwner)
        .initialize(
            "Junior Tranche Vault",
            "JTV",
            poolConfigContract.address,
            JUNIOR_TRANCHE_INDEX
        );
    await mockCreditContract.connect(poolOwner).updatePoolConfigData();

    return [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAlossCovererContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        mockCreditContract,
    ];
}

async function setupPoolContracts(
    poolConfigContract,
    eaNFTContract,
    mockTokenContract,
    poolOwnerAndEAlossCovererContract,
    poolVaultContract,
    poolContract,
    juniorTrancheVaultContract,
    seniorTrancheVaultContract,
    poolOwner,
    evaluationAgent,
    poolOwnerTreasury,
    poolOperator,
    lenders
) {
    await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000_000));
    await poolConfigContract.connect(poolOwner).setMaxCreditLine(toToken(10_000_000));

    await poolConfigContract.connect(poolOwner).setPoolOwnerTreasury(poolOwnerTreasury.address);
    await poolConfigContract.connect(poolOwner).setPoolOwnerRewardsAndLiquidity(625, 10);

    let eaNFTTokenId;
    const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
    const receipt = await tx.wait();
    for (const evt of receipt.events) {
        if (evt.event === "NFTGenerated") {
            eaNFTTokenId = evt.args.tokenId;
        }
    }
    await poolConfigContract
        .connect(poolOwner)
        .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
    await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(1875, 10);

    await poolOwnerAndEAlossCovererContract
        .connect(poolOwner)
        .setOperator(poolOwnerTreasury.address, {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });
    await poolOwnerAndEAlossCovererContract
        .connect(poolOwner)
        .setOperator(evaluationAgent.address, {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });

    let role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.address);
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.address);

    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolOwnerAndEAlossCovererContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(poolOwnerTreasury.address, toToken(100_000_000));
    await poolOwnerAndEAlossCovererContract
        .connect(poolOwnerTreasury)
        .addCover(toToken(10_000_000));

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolOwnerAndEAlossCovererContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(evaluationAgent.address, toToken(100_000_000));
    await poolOwnerAndEAlossCovererContract.connect(evaluationAgent).addCover(toToken(10_000_000));

    // Set pool epoch window to 3 days for testing purposes
    await poolConfigContract.connect(poolOwner).setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_DAY, 3);

    await poolContract.connect(poolOwner).enablePool();
    expect(await poolContract.totalAssets()).to.equal(0);
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
    expect(await juniorTrancheVaultContract.totalSupply()).to.equal(0);
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(0);
    expect(await seniorTrancheVaultContract.totalSupply()).to.equal(0);

    for (let i = 0; i < lenders.length; i++) {
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(lenders[i].address);
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(lenders[i].address);
        await mockTokenContract
            .connect(lenders[i])
            .approve(poolVaultContract.address, ethers.constants.MaxUint256);
        await mockTokenContract.mint(lenders[i].address, toToken(100_000_000));
    }
}

async function deployAndSetupPoolContracts(
    humaConfigContract,
    mockTokenContract,
    eaNFTContract,
    tranchesPolicyContractName,
    deployer,
    poolOwner,
    evaluationAgent,
    poolOwnerTreasury,
    poolOperator,
    lenders
) {
    let [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAlossCovererContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        mockCreditContract,
    ] = await deployPoolContracts(
        humaConfigContract,
        mockTokenContract,
        tranchesPolicyContractName,
        deployer,
        poolOwner
    );

    await setupPoolContracts(
        poolConfigContract,
        eaNFTContract,
        mockTokenContract,
        poolOwnerAndEAlossCovererContract,
        poolVaultContract,
        poolContract,
        juniorTrancheVaultContract,
        seniorTrancheVaultContract,
        poolOwner,
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        lenders
    );

    return [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAlossCovererContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        mockCreditContract,
    ];
}

function getNextDueDate(calendarUnit, lastDate, currentDate, periodDuration) {
    if (calendarUnit === CONSTANTS.CALENDAR_UNIT_DAY) {
        return getNextDate(lastDate, currentDate, periodDuration);
    } else if (calendarUnit === CONSTANTS.CALENDAR_UNIT_MONTH) {
        return getNextMonth(lastDate, currentDate, periodDuration);
    }
}

function checkEpochInfo(
    epochInfo,
    epochId,
    totalShareRequested,
    totalShareProcessed = 0,
    totalAmountProcessed = 0
) {
    expect(epochInfo.epochId).to.equal(epochId);
    expect(epochInfo.totalShareRequested).to.equal(totalShareRequested);
    expect(epochInfo.totalShareProcessed).to.equal(totalShareProcessed);
    expect(epochInfo.totalAmountProcessed).to.equal(totalAmountProcessed);
}

module.exports = {
    deployProtocolContracts,
    deployPoolContracts,
    setupPoolContracts,
    deployAndSetupPoolContracts,
    getNextDueDate,
    checkEpochInfo,
    CONSTANTS,
};
