const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {toToken, getNextDate, getNextMonth} = require("./TestUtils");

const CALENDAR_UNIT_DAY = 0;
const CALENDAR_UNIT_MONTH = 1;
const SENIOR_TRANCHE_INDEX = 0;
const JUNIOR_TRANCHE_INDEX = 1;
const PRICE_DECIMALS_FACTOR = BN.from(10).pow(BN.from(18));
const BP_FACTOR = BN.from(10000);
const SECONDS_IN_YEAR = BN.from(60 * 60 * 24 * 365);

const CONSTANTS = {
    CALENDAR_UNIT_DAY,
    CALENDAR_UNIT_MONTH,
    SENIOR_TRANCHE_INDEX,
    JUNIOR_TRANCHE_INDEX,
    PRICE_DECIMALS_FACTOR,
    BP_FACTOR,
    SECONDS_IN_YEAR,
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
    poolOwner,
    creditContractName
) {
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const poolConfigContract = await PoolConfig.deploy();
    await poolConfigContract.deployed();

    const PlatformFeeManager = await ethers.getContractFactory("PlatformFeeManager");
    const platformFeeManagerContract = await PlatformFeeManager.deploy();
    await platformFeeManagerContract.deployed();

    const PoolVault = await ethers.getContractFactory("PoolVault");
    const poolVaultContract = await PoolVault.deploy();
    await poolVaultContract.deployed();

    const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
    const poolOwnerAndEAFirstLossCoverContract = await FirstLossCover.deploy();
    await poolOwnerAndEAFirstLossCoverContract.deployed();

    const TranchesPolicy = await ethers.getContractFactory(tranchesPolicyContractName);
    const tranchesPolicyContract = await TranchesPolicy.deploy();
    await tranchesPolicyContract.deployed();

    const Pool = await ethers.getContractFactory("Pool");
    const poolContract = await Pool.deploy();
    await poolContract.deployed();

    const EpochManager = await ethers.getContractFactory("EpochManager");
    const epochManagerContract = await EpochManager.deploy();
    await epochManagerContract.deployed();

    const TrancheVault = await ethers.getContractFactory("TrancheVault");
    const seniorTrancheVaultContract = await TrancheVault.deploy();
    await seniorTrancheVaultContract.deployed();
    const juniorTrancheVaultContract = await TrancheVault.deploy();
    await juniorTrancheVaultContract.deployed();

    const Calendar = await ethers.getContractFactory("Calendar");
    const calendarContract = await Calendar.deploy();
    await calendarContract.deployed();

    // const MockCredit = await ethers.getContractFactory("MockCredit");
    // const mockCreditContract = await MockCredit.deploy(poolConfigContract.address);
    // await mockCreditContract.deployed();

    const Credit = await ethers.getContractFactory(creditContractName);
    const creditContract = await Credit.deploy();
    await creditContract.deployed();

    const BaseCreditFeeManager = await ethers.getContractFactory("BaseCreditFeeManager");
    const creditFeeManagerContract = await BaseCreditFeeManager.deploy();
    await creditFeeManagerContract.deployed();

    const CreditPnLManager = await ethers.getContractFactory("LinearMarkdownPnLManager");
    const creditPnlManagerContract = await CreditPnLManager.deploy();
    await creditPnlManagerContract.deployed();

    await poolConfigContract.initialize("Test Pool", [
        humaConfigContract.address,
        mockTokenContract.address,
        platformFeeManagerContract.address,
        poolVaultContract.address,
        calendarContract.address,
        poolOwnerAndEAFirstLossCoverContract.address,
        tranchesPolicyContract.address,
        poolContract.address,
        epochManagerContract.address,
        seniorTrancheVaultContract.address,
        juniorTrancheVaultContract.address,
        creditContract.address,
        creditFeeManagerContract.address,
        creditPnlManagerContract.address,
    ]);

    await poolConfigContract.grantRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.address
    );
    await poolConfigContract.renounceRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        deployer.address
    );

    await platformFeeManagerContract.initialize(poolConfigContract.address);
    await poolVaultContract.initialize(poolConfigContract.address);
    await poolOwnerAndEAFirstLossCoverContract.initialize(poolConfigContract.address);
    await poolContract.initialize(poolConfigContract.address);
    await epochManagerContract.initialize(poolConfigContract.address);
    await seniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Senior Tranche Vault",
        "STV",
        poolConfigContract.address,
        SENIOR_TRANCHE_INDEX
    );
    await juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Junior Tranche Vault",
        "JTV",
        poolConfigContract.address,
        JUNIOR_TRANCHE_INDEX
    );
    await tranchesPolicyContract.initialize(poolConfigContract.address);
    await creditContract.initialize(poolConfigContract.address);
    await creditFeeManagerContract.initialize(poolConfigContract.address);
    await creditPnlManagerContract.initialize(poolConfigContract.address);

    return [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        creditPnlManagerContract,
    ];
}

async function setupPoolContracts(
    poolConfigContract,
    eaNFTContract,
    mockTokenContract,
    poolOwnerAndEAFirstLossCoverContract,
    poolVaultContract,
    poolContract,
    juniorTrancheVaultContract,
    seniorTrancheVaultContract,
    creditContract,
    poolOwner,
    evaluationAgent,
    poolOwnerTreasury,
    poolOperator,
    accounts
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

    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwner)
        .setOperator(poolOwnerTreasury.address, {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });
    await poolOwnerAndEAFirstLossCoverContract
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
        .approve(poolOwnerAndEAFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(poolOwnerTreasury.address, toToken(100_000_000));
    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwnerTreasury)
        .addCover(toToken(10_000_000));

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolOwnerAndEAFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(evaluationAgent.address, toToken(100_000_000));
    await poolOwnerAndEAFirstLossCoverContract
        .connect(evaluationAgent)
        .addCover(toToken(10_000_000));

    // Set pool epoch window to 3 days for testing purposes
    await poolConfigContract.connect(poolOwner).setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_DAY, 3);

    await poolContract.connect(poolOwner).enablePool();
    expect(await poolContract.totalAssets()).to.equal(0);
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
    expect(await juniorTrancheVaultContract.totalSupply()).to.equal(0);
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(0);
    expect(await seniorTrancheVaultContract.totalSupply()).to.equal(0);

    for (let i = 0; i < accounts.length; i++) {
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].address);
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].address);
        await mockTokenContract
            .connect(accounts[i])
            .approve(poolVaultContract.address, ethers.constants.MaxUint256);
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        await mockTokenContract.mint(accounts[i].address, toToken(100_000_000));
    }
}

async function deployAndSetupPoolContracts(
    humaConfigContract,
    mockTokenContract,
    eaNFTContract,
    tranchesPolicyContractName,
    deployer,
    poolOwner,
    creditContractName,
    evaluationAgent,
    poolOwnerTreasury,
    poolOperator,
    accounts
) {
    let [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        creditPnlManagerContract,
    ] = await deployPoolContracts(
        humaConfigContract,
        mockTokenContract,
        tranchesPolicyContractName,
        deployer,
        poolOwner,
        creditContractName
    );

    await setupPoolContracts(
        poolConfigContract,
        eaNFTContract,
        mockTokenContract,
        poolOwnerAndEAFirstLossCoverContract,
        poolVaultContract,
        poolContract,
        juniorTrancheVaultContract,
        seniorTrancheVaultContract,
        creditContract,
        poolOwner,
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        accounts
    );

    return [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        creditPnlManagerContract,
    ];
}

function getNextDueDate(calendarUnit, lastDate, currentDate, periodDuration) {
    if (calendarUnit === CONSTANTS.CALENDAR_UNIT_DAY) {
        return getNextDate(lastDate, currentDate, periodDuration);
    } else if (calendarUnit === CONSTANTS.CALENDAR_UNIT_MONTH) {
        return getNextMonth(lastDate, currentDate, periodDuration);
    }
}

function calcProfitForFixedAprPolicy(
    profit,
    assets,
    lastUpdateTS,
    currentTS,
    deployedAssets,
    apr
) {
    let totalAssets = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
    );
    let seniorDeployedAssets = deployedAssets
        .mul(assets[CONSTANTS.SENIOR_TRANCHE_INDEX])
        .div(totalAssets);
    let seniorProfit = 0;
    if (currentTS > lastUpdateTS) {
        seniorProfit = seniorDeployedAssets
            .mul(currentTS - lastUpdateTS)
            .mul(apr)
            .div(CONSTANTS.SECONDS_IN_YEAR)
            .div(CONSTANTS.BP_FACTOR);
    }
    seniorProfit = seniorProfit.gt(profit) ? profit : seniorProfit;
    let juniorProfit = profit.sub(seniorProfit);

    return [
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(seniorProfit),
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(juniorProfit),
    ];
}

function calcProfitForRiskAdjustedPolicy(profit, assets, riskAdjustment) {
    let totalAssets = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
    );

    let seniorProfit = profit.mul(assets[CONSTANTS.SENIOR_TRANCHE_INDEX]).div(totalAssets);
    let adjustedProfit = seniorProfit.mul(riskAdjustment).div(CONSTANTS.BP_FACTOR);
    seniorProfit = seniorProfit.sub(adjustedProfit);

    return [
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(seniorProfit),
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(profit.sub(seniorProfit)),
    ];
}

function calcLoss(loss, assets) {
    let juniorLoss = loss.gt(assets[CONSTANTS.JUNIOR_TRANCHE_INDEX])
        ? assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        : loss;
    let seniorLoss = loss.sub(juniorLoss);

    return [
        [
            assets[CONSTANTS.SENIOR_TRANCHE_INDEX].sub(seniorLoss),
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].sub(juniorLoss),
        ],
        [seniorLoss, juniorLoss],
    ];
}

function calcLossRecovery(lossRecovery, assets, losses) {
    let seniorRecovery = lossRecovery.gt(losses[CONSTANTS.SENIOR_TRANCHE_INDEX])
        ? losses[CONSTANTS.SENIOR_TRANCHE_INDEX]
        : lossRecovery;
    lossRecovery = lossRecovery.sub(seniorRecovery);
    let juniorRecovery = lossRecovery.gt(losses[CONSTANTS.JUNIOR_TRANCHE_INDEX])
        ? losses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        : lossRecovery;
    lossRecovery = lossRecovery.sub(juniorRecovery);

    return [
        lossRecovery,
        [
            assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(seniorRecovery),
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(juniorRecovery),
        ],
        [
            losses[CONSTANTS.SENIOR_TRANCHE_INDEX].sub(seniorRecovery),
            losses[CONSTANTS.JUNIOR_TRANCHE_INDEX].sub(juniorRecovery),
        ],
    ];
}

const PnLCalculator = {
    calcProfitForFixedAprPolicy,
    calcProfitForRiskAdjustedPolicy,
    calcLoss,
    calcLossRecovery,
};

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

function checkCreditConfig(
    creditConfig,
    creditLimit,
    committedAmount,
    calendarUnit,
    periodDuration,
    numOfPeriods,
    yieldInBps,
    revolving,
    receivableBacked,
    borrowerLevelCredit,
    exclusive
) {
    expect(creditConfig.creditLimit).to.equal(creditLimit);
    expect(creditConfig.committedAmount).to.equal(committedAmount);
    expect(creditConfig.calendarUnit).to.equal(calendarUnit);
    expect(creditConfig.periodDuration).to.equal(periodDuration);
    expect(creditConfig.numOfPeriods).to.equal(numOfPeriods);
    expect(creditConfig.yieldInBps).to.equal(yieldInBps);
    expect(creditConfig.revolving).to.equal(revolving);
    expect(creditConfig.receivableBacked).to.equal(receivableBacked);
    expect(creditConfig.borrowerLevelCredit).to.equal(borrowerLevelCredit);
    expect(creditConfig.exclusive).to.equal(exclusive);
}

function checkCreditRecord(
    creditRecord,
    unbilledPrincipal,
    nextDueDate,
    totalDue,
    yieldDue,
    feesDue,
    missedPeriods,
    remainingPeriods,
    state
) {
    expect(creditRecord.unbilledPrincipal).to.equal(unbilledPrincipal);
    expect(creditRecord.nextDueDate).to.equal(nextDueDate);
    expect(creditRecord.totalDue).to.equal(totalDue);
    expect(creditRecord.yieldDue).to.equal(yieldDue);
    expect(creditRecord.feesDue).to.equal(feesDue);
    expect(creditRecord.missedPeriods).to.equal(missedPeriods);
    expect(creditRecord.remainingPeriods).to.equal(remainingPeriods);
    expect(creditRecord.state).to.equal(state);
}

module.exports = {
    deployProtocolContracts,
    deployPoolContracts,
    setupPoolContracts,
    deployAndSetupPoolContracts,
    getNextDueDate,
    checkEpochInfo,
    checkCreditConfig,
    checkCreditRecord,
    CONSTANTS,
    PnLCalculator,
};
