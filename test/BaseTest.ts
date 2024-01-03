import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN, BigNumber } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";
import {
    BaseTranchesPolicy,
    BorrowerLevelCreditManager,
    Calendar,
    CreditDueManager,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockPoolCredit,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    ReceivableBackedCreditLine,
    ReceivableBackedCreditLineManager,
    ReceivableFactoringCredit,
    ReceivableLevelCreditManager,
    TrancheVault,
} from "../typechain-types";
import { FirstLossCoverConfigStruct } from "../typechain-types/contracts/PoolConfig.sol/PoolConfig";
import {
    CreditRecordStruct,
    CreditRecordStructOutput,
    DueDetailStruct,
    DueDetailStructOutput,
} from "../typechain-types/contracts/credit/Credit";
import {
    CreditConfigStruct,
    CreditConfigStructOutput,
} from "../typechain-types/contracts/credit/CreditManager";
import { EpochRedemptionSummaryStruct } from "../typechain-types/contracts/interfaces/IRedemptionHandler";
import { getLatestBlock, maxBigNumber, minBigNumber, sumBNArray, toToken } from "./TestUtils";

export type CreditContractType =
    | MockPoolCredit
    | CreditLine
    | ReceivableBackedCreditLine
    | ReceivableFactoringCredit;
export type CreditManagerContractType =
    | BorrowerLevelCreditManager
    | ReceivableBackedCreditLineManager
    | ReceivableLevelCreditManager;
export type ProtocolContracts = [EvaluationAgentNFT, HumaConfig, MockToken];
export type PoolContracts = [
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Calendar,
    FirstLossCover,
    FirstLossCover,
    BaseTranchesPolicy,
    Pool,
    EpochManager,
    TrancheVault,
    TrancheVault,
    CreditContractType,
    CreditDueManager,
    CreditManagerContractType,
    Receivable,
];
export type TranchesPolicyContractName =
    | "FixedSeniorYieldTranchePolicy"
    | "RiskAdjustedTranchesPolicy";
export type CreditContractName =
    | "CreditLine"
    | "ReceivableBackedCreditLine"
    | "ReceivableFactoringCredit"
    | "MockPoolCredit";
export type CreditManagerContractName =
    | "BorrowerLevelCreditManager"
    | "ReceivableBackedCreditLineManager"
    | "ReceivableLevelCreditManager";

export enum PayPeriodDuration {
    Monthly,
    Quarterly,
    SemiAnnually,
}

export enum CreditState {
    Deleted,
    Approved,
    GoodStanding,
    Delayed,
    Defaulted,
    Paused,
}

export enum ReceivableState {
    Deleted,
    Minted,
    Approved,
    PartiallyPaid,
    Paid,
    Rejected,
    Delayed,
    Defaulted,
}

export enum CreditClosureReason {
    Paidoff,
    CreditLimitChangedToBeZero,
    OverwrittenByNewLine,
    AdminClosure,
}

const DAYS_IN_A_MONTH = 30;
const DAYS_IN_A_QUARTER = 90;
const DAYS_IN_A_HALF_YEAR = 180;
const DAYS_IN_A_YEAR = 360;
const SENIOR_TRANCHE = 0;
const JUNIOR_TRANCHE = 1;
const DEFAULT_DECIMALS_FACTOR = BN.from(10).pow(18);
const BP_FACTOR = BN.from(10000);
const MONTHS_IN_A_YEAR = 12;
const SECONDS_IN_A_DAY = 24 * 60 * 60;
const SECONDS_IN_A_YEAR = 60 * 60 * 24 * 365;
const BORROWER_FIRST_LOSS_COVER_INDEX = 0;
const AFFILIATE_FIRST_LOSS_COVER_INDEX = 1;

export const CONSTANTS = {
    DAYS_IN_A_MONTH,
    DAYS_IN_A_QUARTER,
    DAYS_IN_A_HALF_YEAR,
    DAYS_IN_A_YEAR,
    SENIOR_TRANCHE,
    JUNIOR_TRANCHE,
    DEFAULT_DECIMALS_FACTOR,
    BP_FACTOR,
    MONTHS_IN_A_YEAR,
    SECONDS_IN_A_DAY,
    SECONDS_IN_A_YEAR,
    BORROWER_FIRST_LOSS_COVER_INDEX,
    AFFILIATE_FIRST_LOSS_COVER_INDEX,
};

export async function deployProtocolContracts(
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress,
    poolOwner: SignerWithAddress,
): Promise<ProtocolContracts> {
    // Deploy EvaluationAgentNFT
    const EvaluationAgentNFT = await ethers.getContractFactory("EvaluationAgentNFT");
    const eaNFTContract = await EvaluationAgentNFT.deploy();
    await eaNFTContract.deployed();

    // Deploy HumaConfig
    const HumaConfig = await ethers.getContractFactory("HumaConfig");
    let humaConfigContract = await HumaConfig.deploy();
    await humaConfigContract.deployed();

    await humaConfigContract.setHumaTreasury(treasury.getAddress());
    await humaConfigContract.setEANFTContractAddress(eaNFTContract.address);
    await humaConfigContract.setEAServiceAccount(eaServiceAccount.getAddress());
    await humaConfigContract.setPDSServiceAccount(pdsServiceAccount.getAddress());

    await humaConfigContract.addPauser(protocolOwner.getAddress());
    await humaConfigContract.addPauser(poolOwner.getAddress());

    await humaConfigContract.transferOwnership(protocolOwner.getAddress());
    if (await humaConfigContract.connect(protocolOwner).paused())
        await humaConfigContract.connect(protocolOwner).unpause();

    const MockToken = await ethers.getContractFactory("MockToken");
    const mockTokenContract = await MockToken.deploy();
    await mockTokenContract.deployed();

    await humaConfigContract
        .connect(protocolOwner)
        .setLiquidityAsset(mockTokenContract.address, true);

    return [eaNFTContract, humaConfigContract, mockTokenContract];
}

export async function deployPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: SignerWithAddress,
    poolOwner: SignerWithAddress,
    creditContractName: CreditContractName,
    creditManagerContractName: CreditManagerContractName,
): Promise<PoolContracts> {
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const poolConfigContract = await PoolConfig.deploy();
    await poolConfigContract.deployed();

    const PoolFeeManager = await ethers.getContractFactory("PoolFeeManager");
    const poolFeeManagerContract = await PoolFeeManager.deploy();
    await poolFeeManagerContract.deployed();

    const PoolSafe = await ethers.getContractFactory("PoolSafe");
    const poolSafeContract = await PoolSafe.deploy();
    await poolSafeContract.deployed();

    const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
    const borrowerFirstLossCoverContract = await FirstLossCover.deploy();
    await borrowerFirstLossCoverContract.deployed();
    const affiliateFirstLossCoverContract = await FirstLossCover.deploy();
    await affiliateFirstLossCoverContract.deployed();

    const TranchesPolicy = await getTranchesPolicyContractFactory(tranchesPolicyContractName);
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

    const Credit = await getCreditContractFactory(creditContractName);
    const creditContract = await Credit.deploy();
    await creditContract.deployed();

    const CreditDueManager = await ethers.getContractFactory("CreditDueManager");
    const creditDueManagerContract = await CreditDueManager.deploy();
    await creditDueManagerContract.deployed();

    const CreditManager = await getCreditManagerContractFactory(creditManagerContractName);
    const creditManagerContract = await CreditManager.deploy();
    await creditManagerContract.deployed();

    const Receivable = await ethers.getContractFactory("Receivable");
    const receivableContract = await Receivable.deploy();
    await receivableContract.deployed();
    await receivableContract.initialize();
    await receivableContract.grantRole(
        receivableContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.getAddress(),
    );
    await receivableContract.renounceRole(
        receivableContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );

    await poolConfigContract.initialize("Test Pool", [
        humaConfigContract.address,
        mockTokenContract.address,
        calendarContract.address,
        poolContract.address,
        poolSafeContract.address,
        poolFeeManagerContract.address,
        tranchesPolicyContract.address,
        epochManagerContract.address,
        seniorTrancheVaultContract.address,
        juniorTrancheVaultContract.address,
        creditContract.address,
        creditDueManagerContract.address,
        creditManagerContract.address,
    ]);
    await poolConfigContract.setFirstLossCover(
        BORROWER_FIRST_LOSS_COVER_INDEX,
        borrowerFirstLossCoverContract.address,
        {
            coverRatePerLossInBps: 0,
            coverCapPerLoss: 0,
            maxLiquidity: toToken(100_000_000),
            minLiquidity: 0,
            riskYieldMultiplierInBps: 0,
        },
    );
    await poolConfigContract.setReceivableAsset(receivableContract.address);
    await poolConfigContract.setFirstLossCover(
        AFFILIATE_FIRST_LOSS_COVER_INDEX,
        affiliateFirstLossCoverContract.address,
        {
            coverRatePerLossInBps: 0,
            coverCapPerLoss: 0,
            maxLiquidity: toToken(100_000_000),
            minLiquidity: 0,
            riskYieldMultiplierInBps: 20000,
        },
    );

    await poolConfigContract.grantRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.getAddress(),
    );
    await poolConfigContract.renounceRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );

    await poolFeeManagerContract.initialize(poolConfigContract.address);
    await poolSafeContract.initialize(poolConfigContract.address);
    await borrowerFirstLossCoverContract["initialize(string,string,address)"](
        "Borrower First Loss Cover",
        "BFLC",
        poolConfigContract.address,
    );
    await affiliateFirstLossCoverContract["initialize(string,string,address)"](
        "Affiliate First Loss Cover",
        "AFLC",
        poolConfigContract.address,
    );
    await tranchesPolicyContract.initialize(poolConfigContract.address);
    await poolContract.initialize(poolConfigContract.address);
    await epochManagerContract.initialize(poolConfigContract.address);
    await seniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Senior Tranche Vault",
        "STV",
        poolConfigContract.address,
        SENIOR_TRANCHE,
    );
    await juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Junior Tranche Vault",
        "JTV",
        poolConfigContract.address,
        JUNIOR_TRANCHE,
    );
    await creditContract.connect(poolOwner).initialize(poolConfigContract.address);
    await creditDueManagerContract.initialize(poolConfigContract.address);
    await creditManagerContract.initialize(poolConfigContract.address);

    return [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditDueManagerContract,
        creditManagerContract,
        receivableContract,
    ];
}

export async function setupPoolContracts(
    poolConfigContract: PoolConfig,
    eaNFTContract: EvaluationAgentNFT,
    mockTokenContract: MockToken,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    poolSafeContract: PoolSafe,
    poolContract: Pool,
    juniorTrancheVaultContract: TrancheVault,
    seniorTrancheVaultContract: TrancheVault,
    creditContract: CreditContractType,
    receivableContract: Receivable,
    poolOwner: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
    shouldSetEA: boolean = true,
): Promise<void> {
    const poolLiquidityCap = toToken(1_000_000_000);
    const settings = await poolConfigContract.getPoolSettings();
    await poolConfigContract
        .connect(poolOwner)
        .setPoolSettings({ ...settings, ...{ maxCreditLine: toToken(10_000_000) } });
    const lpConfig = await poolConfigContract.getLPConfig();
    await poolConfigContract
        .connect(poolOwner)
        .setLPConfig({ ...lpConfig, ...{ liquidityCap: poolLiquidityCap } });

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());

    // Deposit enough liquidity for the pool owner and EA in the junior tranche.
    const adminRnR = await poolConfigContract.getAdminRnR();
    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(1_000_000_000));
    const poolOwnerLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
        .mul(poolLiquidityCap)
        .div(CONSTANTS.BP_FACTOR);
    await juniorTrancheVaultContract
        .connect(poolOwnerTreasury)
        .makeInitialDeposit(poolOwnerLiquidity);
    let expectedInitialLiquidity = poolOwnerLiquidity;

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(1_000_000_000));
    if (shouldSetEA) {
        let eaNFTTokenId;
        const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
        const receipt = await tx.wait();
        for (const evt of receipt.events!) {
            if (evt.event === "NFTGenerated") {
                eaNFTTokenId = evt.args!.tokenId;
            }
        }
        await poolConfigContract
            .connect(poolOwner)
            .setEvaluationAgent(eaNFTTokenId, evaluationAgent.getAddress());
        const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByEA)
            .mul(poolLiquidityCap)
            .div(CONSTANTS.BP_FACTOR);
        await juniorTrancheVaultContract
            .connect(evaluationAgent)
            .makeInitialDeposit(evaluationAgentLiquidity);
        expectedInitialLiquidity = expectedInitialLiquidity.add(evaluationAgentLiquidity);
    }

    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract
        .connect(evaluationAgent)
        .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await affiliateFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(poolOwnerTreasury.getAddress());
    await affiliateFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(evaluationAgent.getAddress());

    const role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());

    await juniorTrancheVaultContract
        .connect(poolOperator)
        .setReinvestYield(poolOwnerTreasury.address, true);
    await juniorTrancheVaultContract
        .connect(poolOperator)
        .setReinvestYield(evaluationAgent.address, true);

    await affiliateFirstLossCoverContract.connect(poolOwnerTreasury).depositCover(toToken(10_000));
    await affiliateFirstLossCoverContract.connect(evaluationAgent).depositCover(toToken(10_000));
    await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true);

    await poolContract.connect(poolOwner).enablePool();
    expect(await poolContract.totalAssets()).to.equal(expectedInitialLiquidity);
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(expectedInitialLiquidity);
    expect(await juniorTrancheVaultContract.totalSupply()).to.equal(expectedInitialLiquidity);
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(0);
    expect(await seniorTrancheVaultContract.totalSupply()).to.equal(0);

    for (let i = 0; i < accounts.length; i++) {
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress(), true);
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress(), true);
        await mockTokenContract
            .connect(accounts[i])
            .approve(poolSafeContract.address, ethers.constants.MaxUint256);
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        await mockTokenContract.mint(accounts[i].getAddress(), toToken(1_000_000_000));
        await receivableContract.grantRole(
            await receivableContract.MINTER_ROLE(),
            accounts[i].getAddress(),
        );
    }
}

export async function deployAndSetupPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken,
    eaNFTContract: EvaluationAgentNFT,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: SignerWithAddress,
    poolOwner: SignerWithAddress,
    creditContractName: CreditContractName,
    creditManagerContractName: CreditManagerContractName,
    evaluationAgent: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
    shouldSetEA: boolean = true,
): Promise<PoolContracts> {
    const [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditDueManagerContract,
        creditManagerContract,
        receivableContract,
    ] = await deployPoolContracts(
        humaConfigContract,
        mockTokenContract,
        tranchesPolicyContractName,
        deployer,
        poolOwner,
        creditContractName,
        creditManagerContractName,
    );

    await setupPoolContracts(
        poolConfigContract,
        eaNFTContract,
        mockTokenContract,
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        poolSafeContract,
        poolContract,
        juniorTrancheVaultContract,
        seniorTrancheVaultContract,
        creditContract,
        poolOwner,
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        accounts,
        shouldSetEA,
    );

    return [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditDueManagerContract,
        creditManagerContract,
        receivableContract,
    ];
}

export type SeniorYieldTracker = { totalAssets: BN; unpaidYield: BN; lastUpdatedDate: BN };

function calcLatestSeniorTracker(
    currentTS: number,
    yieldInBps: number,
    seniorYieldTracker: SeniorYieldTracker,
): SeniorYieldTracker {
    let newSeniorTracker = { ...seniorYieldTracker };
    if (currentTS > newSeniorTracker.lastUpdatedDate.toNumber()) {
        newSeniorTracker.unpaidYield = newSeniorTracker.unpaidYield.add(
            newSeniorTracker.totalAssets
                .mul(BN.from(currentTS).sub(newSeniorTracker.lastUpdatedDate))
                .mul(BN.from(yieldInBps))
                .div(BN.from(CONSTANTS.SECONDS_IN_A_YEAR).mul(CONSTANTS.BP_FACTOR)),
        );
        newSeniorTracker.lastUpdatedDate = BN.from(currentTS);
    }
    return newSeniorTracker;
}

function calcProfitForFixedSeniorYieldPolicy(
    profit: BN,
    assets: BN[],
    currentTS: number,
    yieldInBps: number,
    seniorYieldTracker: SeniorYieldTracker,
): [SeniorYieldTracker, BN[]] {
    let newSeniorTracker = calcLatestSeniorTracker(currentTS, yieldInBps, seniorYieldTracker);
    let seniorProfit = newSeniorTracker.unpaidYield.gt(profit)
        ? profit
        : newSeniorTracker.unpaidYield;
    let juniorProfit = profit.sub(seniorProfit);
    newSeniorTracker.unpaidYield = newSeniorTracker.unpaidYield.sub(seniorProfit);
    newSeniorTracker.totalAssets = assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit);

    return [
        newSeniorTracker,
        [
            assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit),
            assets[CONSTANTS.JUNIOR_TRANCHE].add(juniorProfit),
        ],
    ];
}

function calcProfitForRiskAdjustedPolicy(profit: BN, assets: BN[], riskAdjustment: BN): BN[] {
    const totalAssets = assets[CONSTANTS.SENIOR_TRANCHE].add(assets[CONSTANTS.JUNIOR_TRANCHE]);

    let seniorProfit = profit.mul(assets[CONSTANTS.SENIOR_TRANCHE]).div(totalAssets);
    const adjustedProfit = seniorProfit.mul(riskAdjustment).div(CONSTANTS.BP_FACTOR);
    seniorProfit = seniorProfit.sub(adjustedProfit);

    return [
        assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit),
        assets[CONSTANTS.JUNIOR_TRANCHE].add(profit).sub(seniorProfit),
    ];
}

async function calcProfitForFirstLossCovers(
    profit: BN,
    juniorTotalAssets: BN,
    firstLossCoverInfos: FirstLossCoverInfo[],
): Promise<[BN, BN[]]> {
    const riskWeightedCoverTotalAssets = await Promise.all(
        firstLossCoverInfos.map(async (info, index) =>
            info.asset.mul(await info.config.riskYieldMultiplierInBps).div(CONSTANTS.BP_FACTOR),
        ),
    );
    const totalWeight = juniorTotalAssets.add(sumBNArray(riskWeightedCoverTotalAssets));
    const profitsForFirstLossCovers = riskWeightedCoverTotalAssets.map((value) =>
        profit.mul(value).div(totalWeight),
    );
    const juniorProfit = profit.sub(sumBNArray(profitsForFirstLossCovers));
    return [juniorProfit, profitsForFirstLossCovers];
}

export interface FirstLossCoverInfo {
    config: FirstLossCoverConfigStruct;
    asset: BN;
    coveredLoss: BN;
}

async function calcLossCover(loss: BN, firstLossCoverInfo: FirstLossCoverInfo): Promise<BN[]> {
    const coveredAmount = minBigNumber(
        loss.mul(await firstLossCoverInfo.config.coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
        BN.from(await firstLossCoverInfo.config.coverCapPerLoss),
        firstLossCoverInfo.asset,
        loss,
    );
    return [loss.sub(coveredAmount), coveredAmount];
}

async function calcLoss(
    loss: BN,
    assets: BN[],
    firstLossCoverInfos: FirstLossCoverInfo[],
): Promise<BN[][]> {
    const lossesCoveredByFirstLossCovers = [];
    let coveredAmount;
    for (const info of firstLossCoverInfos) {
        [loss, coveredAmount] = await calcLossCover(loss, info);
        lossesCoveredByFirstLossCovers.push(coveredAmount);
    }
    const juniorLoss = loss.gt(assets[CONSTANTS.JUNIOR_TRANCHE])
        ? assets[CONSTANTS.JUNIOR_TRANCHE]
        : loss;
    const seniorLoss = loss.sub(juniorLoss);

    return [
        [
            assets[CONSTANTS.SENIOR_TRANCHE].sub(seniorLoss),
            assets[CONSTANTS.JUNIOR_TRANCHE].sub(juniorLoss),
        ],
        [seniorLoss, juniorLoss],
        lossesCoveredByFirstLossCovers,
    ];
}

function calcLossRecoveryForFirstLossCover(coveredLoss: BN, recoveryAmount: BN): BN[] {
    const recoveredAmount = minBigNumber(coveredLoss, recoveryAmount);
    return [recoveryAmount.sub(recoveredAmount), recoveredAmount];
}

async function calcLossRecovery(
    lossRecovery: BN,
    assets: BN[],
    losses: BN[],
    lossesCoveredByFirstLossCovers: BN[],
): Promise<[BN, BN[], BN[], BN[]]> {
    const seniorRecovery = lossRecovery.gt(losses[CONSTANTS.SENIOR_TRANCHE])
        ? losses[CONSTANTS.SENIOR_TRANCHE]
        : lossRecovery;
    lossRecovery = lossRecovery.sub(seniorRecovery);
    const juniorRecovery = lossRecovery.gt(losses[CONSTANTS.JUNIOR_TRANCHE])
        ? losses[CONSTANTS.JUNIOR_TRANCHE]
        : lossRecovery;
    lossRecovery = lossRecovery.sub(juniorRecovery);
    const lossRecoveredInFirstLossCovers = [];
    let recoveredAmount;
    for (const coveredLoss of lossesCoveredByFirstLossCovers.slice().reverse()) {
        [lossRecovery, recoveredAmount] = calcLossRecoveryForFirstLossCover(
            coveredLoss,
            lossRecovery,
        );
        lossRecoveredInFirstLossCovers.unshift(recoveredAmount);
    }

    return [
        lossRecovery,
        [
            assets[CONSTANTS.SENIOR_TRANCHE].add(seniorRecovery),
            assets[CONSTANTS.JUNIOR_TRANCHE].add(juniorRecovery),
        ],
        [
            losses[CONSTANTS.SENIOR_TRANCHE].sub(seniorRecovery),
            losses[CONSTANTS.JUNIOR_TRANCHE].sub(juniorRecovery),
        ],
        lossRecoveredInFirstLossCovers,
    ];
}

async function calcRiskAdjustedProfitAndLoss(
    profit: BN,
    loss: BN,
    lossRecovery: BN,
    assets: BN[],
    losses: BN[],
    riskAdjustment: BN,
    firstLossCoverInfos: FirstLossCoverInfo[],
): Promise<[BN[], BN[], BN[], BN[], BN[]]> {
    const assetsAfterProfit = calcProfitForRiskAdjustedPolicy(profit, assets, riskAdjustment);
    const [juniorProfitAfterFirstLossCoverProfitDistribution, profitsForFirstLossCovers] =
        await PnLCalculator.calcProfitForFirstLossCovers(
            assetsAfterProfit[CONSTANTS.JUNIOR_TRANCHE].sub(assets[CONSTANTS.JUNIOR_TRANCHE]),
            assets[CONSTANTS.JUNIOR_TRANCHE],
            firstLossCoverInfos,
        );
    const [assetsAfterLoss, newTranchesLosses, lossesCoveredByFirstLossCovers] =
        await PnLCalculator.calcLoss(
            loss,
            [
                assetsAfterProfit[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE].add(
                    juniorProfitAfterFirstLossCoverProfitDistribution,
                ),
            ],
            firstLossCoverInfos,
        );

    // Add existing losses to new losses to calculate recovery.
    const totalTranchesLosses = [
        newTranchesLosses[CONSTANTS.SENIOR_TRANCHE].add(losses[CONSTANTS.SENIOR_TRANCHE]),
        newTranchesLosses[CONSTANTS.JUNIOR_TRANCHE].add(losses[CONSTANTS.JUNIOR_TRANCHE]),
    ];
    const totalLossesCoveredByFirstLossCovers = firstLossCoverInfos.map((info, index) =>
        info.coveredLoss.add(lossesCoveredByFirstLossCovers[index]),
    );
    const [, assetsAfterRecovery, lossesAfterRecovery, lossesRecoveredByFirstLossCovers] =
        await PnLCalculator.calcLossRecovery(
            lossRecovery,
            assetsAfterLoss,
            totalTranchesLosses,
            totalLossesCoveredByFirstLossCovers,
        );
    return [
        assetsAfterRecovery,
        lossesAfterRecovery,
        profitsForFirstLossCovers,
        lossesRecoveredByFirstLossCovers,
        totalLossesCoveredByFirstLossCovers,
    ];
}

export const PnLCalculator = {
    calcProfitForFixedSeniorYieldPolicy,
    calcLatestSeniorTracker,
    calcProfitForRiskAdjustedPolicy,
    calcProfitForFirstLossCovers,
    calcLoss,
    calcLossRecovery,
    calcRiskAdjustedProfitAndLoss,
};

export class FeeCalculator {
    humaConfigContract: HumaConfig;
    poolConfigContract: PoolConfig;

    constructor(humaConfigContract: HumaConfig, poolConfigContract: PoolConfig) {
        this.humaConfigContract = humaConfigContract;
        this.poolConfigContract = poolConfigContract;
    }

    async calcPoolFeesForDrawdown(borrowedAmount: BN): Promise<BN[]> {
        const [frontLoadingFeeFlat, frontLoadingFeeBps] =
            await this.poolConfigContract.getFrontLoadingFees();
        const profit = frontLoadingFeeFlat.add(
            borrowedAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
        );
        const [protocolFee, poolOwnerFee, eaFee, poolProfit] =
            await this.calcPoolFeesForProfit(profit);
        const amountToBorrower = borrowedAmount.sub(profit);
        return [protocolFee, poolOwnerFee, eaFee, poolProfit, amountToBorrower];
    }

    async calcPoolFeesForProfit(profit: BN): Promise<BN[]> {
        const protocolFeeInBps = await this.humaConfigContract.protocolFeeInBps();
        const adminRnR = await this.poolConfigContract.getAdminRnR();
        const protocolFee = profit.mul(BN.from(protocolFeeInBps)).div(CONSTANTS.BP_FACTOR);
        let remaining = profit.sub(protocolFee);
        const poolOwnerFee = remaining
            .mul(BN.from(adminRnR.rewardRateInBpsForPoolOwner))
            .div(CONSTANTS.BP_FACTOR);
        const eaFee = remaining
            .mul(BN.from(adminRnR.rewardRateInBpsForEA))
            .div(CONSTANTS.BP_FACTOR);
        const poolProfit = remaining.sub(poolOwnerFee.add(eaFee));
        return [protocolFee, poolOwnerFee, eaFee, poolProfit];
    }

    // TODO: try to deprecate this function later
    async calcPoolFeeDistribution(profit: BN): Promise<BN> {
        const protocolFeeInBps = await this.humaConfigContract.protocolFeeInBps();
        const adminRnR = await this.poolConfigContract.getAdminRnR();
        const [, remaining] = calcPoolFees(
            profit,
            protocolFeeInBps,
            adminRnR.rewardRateInBpsForPoolOwner,
            adminRnR.rewardRateInBpsForEA,
        );
        return remaining;
    }
}

export class ProfitAndLossCalculator {
    poolConfigContract: PoolConfig;
    poolContract: Pool;
    firstLossCoverContracts: FirstLossCover[];

    tranchesAssets: BN[] = [];
    firstLossCoverInfos: FirstLossCoverInfo[] = [];

    constructor(
        poolConfigContract: PoolConfig,
        poolContract: Pool,
        firstLossCoverContracts: FirstLossCover[],
    ) {
        this.poolConfigContract = poolConfigContract;
        this.poolContract = poolContract;
        this.firstLossCoverContracts = firstLossCoverContracts;
    }

    async beginProfitCalculation() {
        this.tranchesAssets = await this.poolContract.currentTranchesAssets();
        this.firstLossCoverInfos = await Promise.all(
            this.firstLossCoverContracts.map(async (firstLossCoverContract) => {
                let asset = await firstLossCoverContract.totalAssets();
                let coveredLoss = await firstLossCoverContract.coveredLoss();
                let config = await this.poolConfigContract.getFirstLossCoverConfig(
                    firstLossCoverContract.address,
                );
                return { asset, config, coveredLoss };
            }),
        );
        await Promise.all(
            this.firstLossCoverContracts.map(async (firstLossCoverContract, index) => {}),
        );
    }

    async endRiskAdjustedProfitCalculation(profit: BN): Promise<[BN[], BN[], BN[]]> {
        return await this._endRiskAdjustedProfitCalculation(profit);
    }
    async endRiskAdjustedProfitAndLossCalculation(
        profit: BN,
        loss: BN,
    ): Promise<[BN[], BN[], BN[]]> {
        let [assets, profitsForAssets, profitsForFirstLossCovers] =
            await this._endRiskAdjustedProfitCalculation(profit);
        this.firstLossCoverInfos.forEach((info, index) => {
            info.asset = info.asset.add(profitsForFirstLossCovers[index]);
        });

        let [newAssets, lossesForAssets, lossesForFirstLossCovers] = await calcLoss(
            loss,
            assets,
            this.firstLossCoverInfos,
        );

        return [
            newAssets,
            profitsForAssets.map((c, index) => c.sub(lossesForAssets[index])),
            profitsForFirstLossCovers.map((c, index) => c.sub(lossesForFirstLossCovers[index])),
        ];
    }

    async endFixedSeniorYieldProfitCalculation(
        profit: BN,
        tracker: SeniorYieldTracker,
    ): Promise<[BN[], BN[], BN[], SeniorYieldTracker]> {
        return await this._endFixedSeniorYieldProfitCalculation(profit, tracker);
    }

    async endFixedSeniorYieldProfitAndLossCalculation(
        profit: BN,
        tracker: SeniorYieldTracker,
        loss: BN,
    ): Promise<[BN[], BN[], BN[], SeniorYieldTracker]> {
        let [assets, profitsForAssets, profitsForFirstLossCovers, newTracker] =
            await this._endFixedSeniorYieldProfitCalculation(profit, tracker);
        this.firstLossCoverInfos.forEach((info, index) => {
            info.asset = info.asset.add(profitsForFirstLossCovers[index]);
        });

        let [newAssets, lossesForAssets, lossesForFirstLossCovers] = await calcLoss(
            loss,
            assets,
            this.firstLossCoverInfos,
        );

        return [
            newAssets,
            profitsForAssets.map((c, index) => c.sub(lossesForAssets[index])),
            profitsForFirstLossCovers.map((c, index) => c.sub(lossesForFirstLossCovers[index])),
            newTracker,
        ];
    }

    private async _endRiskAdjustedProfitCalculation(profit: BN): Promise<[BN[], BN[], BN[]]> {
        let lpConfig = await this.poolConfigContract.getLPConfig();
        let assets = await calcProfitForRiskAdjustedPolicy(
            profit,
            this.tranchesAssets,
            BN.from(lpConfig.tranchesRiskAdjustmentInBps),
        );
        let [juniorProfit, firstLossCoverProfits] = await calcProfitForFirstLossCovers(
            assets[CONSTANTS.JUNIOR_TRANCHE].sub(this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE]),
            this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
            this.firstLossCoverInfos,
        );
        assets[CONSTANTS.JUNIOR_TRANCHE] =
            this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE].add(juniorProfit);
        let trancheProfits = [
            assets[CONSTANTS.SENIOR_TRANCHE].sub(this.tranchesAssets[CONSTANTS.SENIOR_TRANCHE]),
            juniorProfit,
        ];

        return [assets, trancheProfits, firstLossCoverProfits];
    }

    private async _endFixedSeniorYieldProfitCalculation(
        profit: BN,
        tracker: SeniorYieldTracker,
    ): Promise<[BN[], BN[], BN[], SeniorYieldTracker]> {
        let lpConfig = await this.poolConfigContract.getLPConfig();
        let block = await getLatestBlock();
        let [newTracker, assets] = await calcProfitForFixedSeniorYieldPolicy(
            profit,
            this.tranchesAssets,
            block.timestamp,
            lpConfig.fixedSeniorYieldInBps,
            tracker,
        );

        let [juniorProfit, firstLossCoverProfits] = await calcProfitForFirstLossCovers(
            assets[CONSTANTS.JUNIOR_TRANCHE].sub(this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE]),
            this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
            this.firstLossCoverInfos,
        );
        assets[CONSTANTS.JUNIOR_TRANCHE] =
            this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE].add(juniorProfit);
        let trancheProfits = [
            assets[CONSTANTS.SENIOR_TRANCHE].sub(this.tranchesAssets[CONSTANTS.SENIOR_TRANCHE]),
            juniorProfit,
        ];

        return [assets, trancheProfits, firstLossCoverProfits, newTracker];
    }
}

export function checkRedemptionSummary(
    redemptionSummary: EpochRedemptionSummaryStruct,
    epochId: BN,
    totalSharesRequested: BN,
    totalSharesProcessed: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    delta: number = 0,
): void {
    expect(redemptionSummary.epochId).to.equal(epochId);
    expect(redemptionSummary.totalSharesRequested).to.be.closeTo(totalSharesRequested, delta);
    expect(redemptionSummary.totalSharesProcessed).to.be.closeTo(totalSharesProcessed, delta);
    expect(redemptionSummary.totalAmountProcessed).to.be.closeTo(totalAmountProcessed, delta);
}

export class EpochChecker {
    epochManagerContract: EpochManager;
    seniorTrancheVaultContract: TrancheVault;
    juniorTrancheVaultContract: TrancheVault;

    constructor(
        epochManagerContract: EpochManager,
        seniorTrancheVaultContract: TrancheVault,
        juniorTrancheVaultContract: TrancheVault,
    ) {
        this.epochManagerContract = epochManagerContract;
        this.seniorTrancheVaultContract = seniorTrancheVaultContract;
        this.juniorTrancheVaultContract = juniorTrancheVaultContract;
    }

    async checkSeniorCurrentEpochEmpty() {
        return await this.checkCurrentEpochEmpty(this.seniorTrancheVaultContract);
    }

    async checkJuniorCurrentEpochEmpty() {
        return await this.checkCurrentEpochEmpty(this.juniorTrancheVaultContract);
    }

    async checkSeniorCurrentRedemptionSummary(
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        return await this.checkCurrentRedemptionSummary(
            this.seniorTrancheVaultContract,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkJuniorCurrentRedemptionSummary(
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        return await this.checkCurrentRedemptionSummary(
            this.juniorTrancheVaultContract,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkSeniorRedemptionSummaryById(
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        await this.checkRedemptionSummaryById(
            this.seniorTrancheVaultContract,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkJuniorRedemptionSummaryById(
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        await this.checkRedemptionSummaryById(
            this.juniorTrancheVaultContract,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    private async checkCurrentEpochEmpty(trancheContract: TrancheVault) {
        const epochId = await this.epochManagerContract.currentEpochId();
        const epoch = await trancheContract.epochRedemptionSummaries(epochId);
        checkRedemptionSummary(epoch, BN.from(0), BN.from(0), BN.from(0), BN.from(0));
        return epochId;
    }

    private async checkCurrentRedemptionSummary(
        trancheContract: TrancheVault,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        const epochId = await this.epochManagerContract.currentEpochId();
        const epoch = await trancheContract.epochRedemptionSummaries(epochId);
        checkRedemptionSummary(
            epoch,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
        return epochId;
    }

    private async checkRedemptionSummaryById(
        trancheContract: TrancheVault,
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        const epoch = await trancheContract.epochRedemptionSummaries(epochId);
        checkRedemptionSummary(
            epoch,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }
}

export function checkCreditConfigsMatch(
    actualCC: CreditConfigStruct,
    expectedCC: CreditConfigStruct,
) {
    expect(actualCC.creditLimit).to.equal(expectedCC.creditLimit);
    expect(actualCC.committedAmount).to.equal(expectedCC.committedAmount);
    expect(actualCC.periodDuration).to.equal(expectedCC.periodDuration);
    expect(actualCC.numOfPeriods).to.equal(expectedCC.numOfPeriods);
    expect(actualCC.revolving).to.equal(expectedCC.revolving);
    expect(actualCC.yieldInBps).to.equal(expectedCC.yieldInBps);
    expect(actualCC.advanceRateInBps).to.equal(expectedCC.advanceRateInBps);
    expect(actualCC.autoApproval).to.equal(expectedCC.autoApproval);
}

export function checkCreditConfig(
    creditConfig: CreditConfigStruct,
    creditLimit: BN,
    committedAmount: BN,
    periodDuration: number,
    numOfPeriods: number,
    yieldInBps: number,
    revolving: boolean,
    advanceRateInBps: number,
    autoApproval: boolean,
) {
    expect(creditConfig.creditLimit).to.equal(creditLimit);
    expect(creditConfig.committedAmount).to.equal(committedAmount);
    expect(creditConfig.periodDuration).to.equal(periodDuration);
    expect(creditConfig.numOfPeriods).to.equal(numOfPeriods);
    expect(creditConfig.yieldInBps).to.equal(yieldInBps);
    expect(creditConfig.revolving).to.equal(revolving);
    expect(creditConfig.advanceRateInBps).to.equal(advanceRateInBps);
    expect(creditConfig.autoApproval).to.equal(autoApproval);
}

export function checkCreditRecordsMatch(
    actualCR: CreditRecordStruct,
    expectedCR: CreditRecordStruct,
    delta: BN = BN.from(0),
) {
    expect(actualCR.unbilledPrincipal).to.equal(expectedCR.unbilledPrincipal);
    expect(actualCR.nextDueDate).to.equal(expectedCR.nextDueDate);
    expect(actualCR.nextDue).to.be.closeTo(expectedCR.nextDue, delta);
    expect(actualCR.yieldDue).to.be.closeTo(expectedCR.yieldDue, delta);
    expect(actualCR.totalPastDue).to.equal(expectedCR.totalPastDue);
    expect(actualCR.missedPeriods).to.equal(expectedCR.missedPeriods);
    expect(actualCR.remainingPeriods).to.equal(expectedCR.remainingPeriods);
    expect(actualCR.state).to.equal(expectedCR.state);
}

export function checkCreditRecord(
    creditRecord: CreditRecordStruct,
    unbilledPrincipal: BN,
    nextDueDate: BN | number,
    nextDue: BN,
    yieldDue: BN,
    totalPastDue: BN,
    missedPeriods: number,
    remainingPeriods: number,
    state: CreditState,
) {
    expect(creditRecord.unbilledPrincipal).to.equal(unbilledPrincipal);
    expect(creditRecord.nextDueDate).to.equal(nextDueDate);
    expect(creditRecord.nextDue).to.equal(nextDue);
    expect(creditRecord.yieldDue).to.equal(yieldDue);
    expect(creditRecord.totalPastDue).to.equal(totalPastDue);
    expect(creditRecord.missedPeriods).to.equal(missedPeriods);
    expect(creditRecord.remainingPeriods).to.equal(remainingPeriods);
    expect(creditRecord.state).to.equal(state);
}

export function genDueDetail(ddOverrides: Partial<DueDetailStruct>): DueDetailStruct {
    return {
        ...{
            lateFeeUpdatedDate: 0,
            lateFee: 0,
            yieldPastDue: 0,
            principalPastDue: 0,
            committed: 0,
            accrued: 0,
            paid: 0,
        },
        ...ddOverrides,
    };
}

export function checkDueDetailsMatch(
    actualDD: DueDetailStruct,
    expectedDD: DueDetailStruct,
    delta: BN = BN.from(0),
) {
    expect(actualDD.lateFeeUpdatedDate).to.equal(expectedDD.lateFeeUpdatedDate);
    expect(actualDD.lateFee).to.equal(expectedDD.lateFee);
    expect(actualDD.principalPastDue).to.equal(expectedDD.principalPastDue);
    expect(actualDD.yieldPastDue).to.equal(expectedDD.yieldPastDue);
    expect(actualDD.committed).to.be.closeTo(expectedDD.committed, delta);
    expect(actualDD.accrued).to.be.closeTo(expectedDD.accrued, delta);
    expect(actualDD.paid).to.equal(expectedDD.paid);
}

export function printSeniorYieldTracker(tracker: SeniorYieldTracker) {
    console.log(`[${tracker.totalAssets}, ${tracker.unpaidYield}, ${tracker.lastUpdatedDate}]`);
}

export function checkSeniorYieldTrackersMatch(
    actualST: SeniorYieldTracker,
    expectedST: SeniorYieldTracker,
    delta: BN = BN.from(0),
) {
    expect(actualST.totalAssets).to.be.closeTo(expectedST.totalAssets, delta);
    expect(actualST.unpaidYield).to.be.closeTo(expectedST.unpaidYield, delta);
    expect(actualST.lastUpdatedDate).to.be.closeTo(expectedST.lastUpdatedDate, delta);
}

export function calcYieldDue(
    cc: CreditConfigStruct,
    principal: BigNumber,
    daysPassed: number,
): [BigNumber, BigNumber] {
    if (daysPassed == 0) {
        return [BN.from(0), BN.from(0)];
    }
    const accrued = calcYield(principal, Number(cc.yieldInBps), daysPassed);
    const committed = calcYield(BN.from(cc.committedAmount), Number(cc.yieldInBps), daysPassed);
    return [accrued, committed];
}

export async function calcYieldDueNew(
    calendarContract: Calendar,
    cc: CreditConfigStructOutput,
    cr: CreditRecordStructOutput,
    dd: DueDetailStructOutput,
    currentDate: moment.Moment,
    maturityDate: moment.Moment,
    latePaymentGracePeriodInDays: number,
): Promise<[BigNumber, BigNumber, [BigNumber, BigNumber]]> {
    const nextBillRefreshDate = getNextBillRefreshDate(
        cr,
        currentDate,
        latePaymentGracePeriodInDays,
    );
    if (currentDate.isSameOrBefore(nextBillRefreshDate)) {
        return [dd.yieldPastDue, cr.yieldDue, [dd.accrued, dd.committed]];
    }

    const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
        cc.periodDuration,
        currentDate.unix(),
    );
    const principal = getPrincipal(cr, dd);
    if (cr.state === CreditState.Approved) {
        const daysUntilNextDue = await calendarContract.getDaysDiff(
            currentDate.unix(),
            nextDueDate,
        );
        const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
            cc,
            principal,
            daysUntilNextDue.toNumber(),
        );
        return [
            BN.from(0),
            maxBigNumber(accruedYieldNextDue, committedYieldNextDue),
            [accruedYieldNextDue, committedYieldNextDue],
        ];
    }
    let daysOverdue, daysUntilNextDue;
    if (currentDate.isAfter(maturityDate)) {
        daysOverdue = await calendarContract.getDaysDiff(cr.nextDueDate, maturityDate.unix());
        daysUntilNextDue = BN.from(0);
    } else {
        const periodStartDate = await calendarContract.getStartDateOfPeriod(
            cc.periodDuration,
            currentDate.unix(),
        );
        daysOverdue = await calendarContract.getDaysDiff(cr.nextDueDate, periodStartDate);
        daysUntilNextDue = await calendarContract.getDaysDiff(
            periodStartDate,
            minBigNumber(BN.from(maturityDate.unix()), nextDueDate),
        );
    }

    const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
        cc,
        principal,
        daysOverdue.toNumber(),
    );
    const yieldPastDue = maxBigNumber(accruedYieldPastDue, committedYieldPastDue);
    const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
        cc,
        principal,
        daysUntilNextDue.toNumber(),
    );
    const yieldNextDue = maxBigNumber(accruedYieldNextDue, committedYieldNextDue);
    return [
        yieldPastDue.add(dd.yieldPastDue).add(cr.yieldDue),
        yieldNextDue,
        [accruedYieldNextDue, committedYieldNextDue],
    ];
}

// Returns three values in the following order:
// 1. Unbilled principal
// 2. Principal past due
// 3. Principal next due
export async function calcPrincipalDue(
    calendarContract: Calendar,
    initialPrincipal: BN,
    currentDate: number,
    lastDueDate: number,
    nextDueDate: number,
    periodDuration: number,
    principalRateInBps: number,
): Promise<[BN, BN, BN]> {
    if (currentDate >= nextDueDate) {
        // All principal is past due if the current date has passed the
        // next due date. Note that the next due date can only be the maturity
        // date in this case.
        return [BN.from(0), initialPrincipal, BN.from(0)];
    }
    const totalDaysInFullPeriod = await calendarContract.getTotalDaysInFullPeriod(periodDuration);
    if (lastDueDate == 0) {
        // During first drawdown, there is no principal past due, only next due.
        const daysUntilNextDue = await calendarContract.getDaysDiff(currentDate, nextDueDate);
        const principalNextDue = initialPrincipal
            .mul(principalRateInBps)
            .mul(daysUntilNextDue)
            .div(totalDaysInFullPeriod.mul(CONSTANTS.BP_FACTOR));
        return [initialPrincipal.sub(principalNextDue), BN.from(0), principalNextDue];
    }
    // Otherwise, there is both principal past due and next due.
    const periodStartDate = await calendarContract.getStartDateOfPeriod(
        periodDuration,
        currentDate,
    );
    const numPeriodsPassed = await calendarContract.getNumPeriodsPassed(
        periodDuration,
        lastDueDate,
        periodStartDate,
    );
    const principalPastDue = CONSTANTS.BP_FACTOR.pow(numPeriodsPassed)
        .sub(CONSTANTS.BP_FACTOR.sub(principalRateInBps).pow(numPeriodsPassed))
        .mul(initialPrincipal)
        .div(CONSTANTS.BP_FACTOR.pow(numPeriodsPassed));
    const daysUntilNextDue = await calendarContract.getDaysDiff(periodStartDate, nextDueDate);
    const principalNextDue = initialPrincipal
        .sub(principalPastDue)
        .mul(principalRateInBps)
        .mul(daysUntilNextDue)
        .div(totalDaysInFullPeriod.mul(CONSTANTS.BP_FACTOR));
    return [
        initialPrincipal.sub(principalPastDue).sub(principalNextDue),
        principalPastDue,
        principalNextDue,
    ];
}

export async function calcPrincipalDueNew(
    calendarContract: Calendar,
    cc: CreditConfigStructOutput,
    cr: CreditRecordStructOutput,
    dd: DueDetailStructOutput,
    currentDate: moment.Moment,
    maturityDate: moment.Moment,
    latePaymentGracePeriodInDays: number,
    principalRateInBps: number,
): Promise<[BN, BN, BN]> {
    const principal = getPrincipal(cr, dd);
    if (
        currentDate.isSameOrBefore(
            getNextBillRefreshDate(cr, currentDate, latePaymentGracePeriodInDays),
        )
    ) {
        // Return the current due info as-is if the current date is within the bill refresh date.
        return [cr.unbilledPrincipal, dd.principalPastDue, cr.nextDue.sub(cr.yieldDue)];
    }
    if (currentDate.isAfter(maturityDate)) {
        // All principal is past due if the current date has passed the maturity date.
        return [BN.from(0), principal, BN.from(0)];
    }
    const totalDaysInFullPeriod = await calendarContract.getTotalDaysInFullPeriod(
        cc.periodDuration,
    );
    if (cr.state === CreditState.Approved) {
        // During first drawdown, there is no principal past due, only next due.
        const daysUntilNextDue = await calendarContract.getDaysDiff(
            currentDate.unix(),
            cr.nextDueDate,
        );
        const principalNextDue = principal
            .mul(principalRateInBps)
            .mul(daysUntilNextDue)
            .div(totalDaysInFullPeriod.mul(CONSTANTS.BP_FACTOR));
        return [cr.unbilledPrincipal.sub(principalNextDue), BN.from(0), principalNextDue];
    }
    // Otherwise, there is both principal past due and next due.
    const periodStartDate = await calendarContract.getStartDateOfPeriod(
        cc.periodDuration,
        currentDate.unix(),
    );
    const numPeriodsPassed = await calendarContract.getNumPeriodsPassed(
        cc.periodDuration,
        cr.nextDueDate,
        periodStartDate,
    );
    const principalPastDue = CONSTANTS.BP_FACTOR.pow(numPeriodsPassed)
        .sub(CONSTANTS.BP_FACTOR.sub(principalRateInBps).pow(numPeriodsPassed))
        .mul(cr.unbilledPrincipal)
        .div(CONSTANTS.BP_FACTOR.pow(numPeriodsPassed));
    const remainingPrincipal = cr.unbilledPrincipal.sub(principalPastDue);
    const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
        cc.periodDuration,
        currentDate.unix(),
    );
    const daysUntilNextDue = await calendarContract.getDaysDiff(periodStartDate, nextDueDate);
    let principalNextDue;
    if (nextDueDate.eq(maturityDate.unix())) {
        principalNextDue = remainingPrincipal;
    } else {
        principalNextDue = remainingPrincipal
            .mul(principalRateInBps)
            .mul(daysUntilNextDue)
            .div(totalDaysInFullPeriod.mul(CONSTANTS.BP_FACTOR));
    }
    return [
        remainingPrincipal.sub(principalNextDue),
        principalPastDue.add(dd.principalPastDue).add(cr.nextDue.sub(cr.yieldDue)),
        principalNextDue,
    ];
}

export async function calcLateFee(
    poolConfigContract: PoolConfig,
    calendarContract: Calendar,
    cc: CreditConfigStruct,
    cr: CreditRecordStruct,
    dd: DueDetailStruct,
    timestamp: number = 0,
): Promise<[BN, BN]> {
    const lateFeeInBps = (await poolConfigContract.getFeeStructure()).lateFeeBps;
    let lateFeeStartDate;
    if (cr.state == CreditState.GoodStanding) {
        if (BN.from(cr.nextDue).isZero()) {
            lateFeeStartDate = await calendarContract.getStartDateOfNextPeriod(
                cc.periodDuration,
                cr.nextDueDate,
            );
        } else {
            lateFeeStartDate = cr.nextDueDate;
        }
    } else {
        lateFeeStartDate = dd.lateFeeUpdatedDate;
    }
    const currentTS = (await getLatestBlock()).timestamp;
    const lateFeeUpdatedDate = await calendarContract.getStartOfNextDay(
        timestamp === 0 ? currentTS : timestamp,
    );
    const principal = getPrincipal(cr, dd);
    const lateFeeBasis = maxBigNumber(principal, BN.from(cc.committedAmount));
    const lateFeeDays = await calendarContract.getDaysDiff(lateFeeStartDate, lateFeeUpdatedDate);
    return [
        lateFeeUpdatedDate,
        BN.from(dd.lateFee).add(
            lateFeeBasis
                .mul(lateFeeInBps)
                .mul(lateFeeDays)
                .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.DAYS_IN_A_YEAR)),
        ),
    ];
}

export async function calcLateFeeNew(
    poolConfigContract: PoolConfig,
    calendarContract: Calendar,
    cc: CreditConfigStructOutput,
    cr: CreditRecordStructOutput,
    dd: DueDetailStructOutput,
    currentDate: moment.Moment,
    latePaymentGracePeriodInDays: number,
): Promise<[BN, BN]> {
    if (
        (currentDate.isBefore(
            getLatePaymentGracePeriodDeadline(cr, latePaymentGracePeriodInDays),
        ) &&
            cr.state === CreditState.GoodStanding) ||
        (cr.nextDue.isZero() && cr.totalPastDue.isZero()) ||
        cr.state == CreditState.Defaulted
    ) {
        return [dd.lateFeeUpdatedDate, dd.lateFee];
    }
    const lateFeeInBps = (await poolConfigContract.getFeeStructure()).lateFeeBps;
    let lateFeeStartDate;
    if (cr.state == CreditState.GoodStanding) {
        if (cr.nextDue.isZero()) {
            lateFeeStartDate = await calendarContract.getStartDateOfNextPeriod(
                cc.periodDuration,
                cr.nextDueDate,
            );
        } else {
            lateFeeStartDate = cr.nextDueDate;
        }
    } else {
        lateFeeStartDate = dd.lateFeeUpdatedDate;
    }
    const lateFeeUpdatedDate = currentDate.clone().add(1, "day").startOf("day");
    const principal = getPrincipal(cr, dd);
    const lateFeeBasis = maxBigNumber(principal, cc.committedAmount);
    const lateFeeDays = await calendarContract.getDaysDiff(
        lateFeeStartDate,
        lateFeeUpdatedDate.unix(),
    );
    return [
        BN.from(lateFeeUpdatedDate.unix()),
        BN.from(dd.lateFee).add(
            lateFeeBasis
                .mul(lateFeeInBps)
                .mul(lateFeeDays)
                .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.DAYS_IN_A_YEAR)),
        ),
    ];
}

export function getPrincipal(cr: CreditRecordStruct, dd: DueDetailStruct): BN {
    return BN.from(cr.unbilledPrincipal)
        .add(BN.from(cr.nextDue).sub(BN.from(cr.yieldDue)))
        .add(BN.from(dd.principalPastDue));
}

export function getNextBillRefreshDate(
    cr: CreditRecordStructOutput,
    currentDate: moment.Moment,
    latePaymentGracePeriodInDays: number,
) {
    const latePaymentDeadline = getLatePaymentGracePeriodDeadline(
        cr,
        latePaymentGracePeriodInDays,
    );
    if (cr.state === CreditState.GoodStanding && currentDate.isBefore(latePaymentDeadline)) {
        // If this is the first time ever that the bill has surpassed the due dat, then we don't want to refresh
        // the bill since we want the user to focus on paying off the current due.
        return latePaymentDeadline;
    }
    return moment.utc(cr.nextDueDate.toNumber() * 1000);
}

export function getLatePaymentGracePeriodDeadline(
    cr: CreditRecordStructOutput,
    latePaymentGracePeriodInDays: number,
) {
    return moment.utc(cr.nextDueDate.toNumber() * 1000).add(latePaymentGracePeriodInDays, "days");
}

export function getTotalDaysInPeriod(periodDuration: number) {
    switch (periodDuration) {
        case PayPeriodDuration.Monthly:
            return CONSTANTS.DAYS_IN_A_MONTH;
        case PayPeriodDuration.Quarterly:
            return CONSTANTS.DAYS_IN_A_QUARTER;
        case PayPeriodDuration.SemiAnnually:
            return CONSTANTS.DAYS_IN_A_HALF_YEAR;
        default:
            throw Error("Invalid period duration");
    }
}

export function printCreditRecord(name: string, creditRecord: CreditRecordStruct) {
    console.log(
        `${name}[
            unbilledPrincipal: ${creditRecord.unbilledPrincipal},
            nextDueDate: ${creditRecord.nextDueDate},
            nextDue: ${creditRecord.nextDue},
            yieldDue: ${creditRecord.yieldDue},
            totalPastDue: ${creditRecord.totalPastDue},
            missedPeriods: ${creditRecord.missedPeriods},
            remainingPeriods: ${creditRecord.remainingPeriods},
            state: ${creditRecord.state}]`,
    );
}

async function getTranchesPolicyContractFactory(
    tranchesPolicyContractName: TranchesPolicyContractName,
) {
    // Note: Both branches contain identical logic, which might seem unusual at first glance.
    // This structure is intentional and solely to satisfy TypeScript's type inference.
    // The TypeScript compiler cannot deduce the specific return types based solely on the input values,
    // so this approach ensures correct type association for each possible input.
    switch (tranchesPolicyContractName) {
        case "FixedSeniorYieldTranchePolicy":
            return await ethers.getContractFactory(tranchesPolicyContractName);
        case "RiskAdjustedTranchesPolicy":
            return await ethers.getContractFactory(tranchesPolicyContractName);
        default:
            throw new Error("Invalid tranchesPolicyContractName");
    }
}

async function getCreditContractFactory(creditContractName: CreditContractName) {
    // Note: All branches contain identical logic, which might seem unusual at first glance.
    // This structure is intentional and solely to satisfy TypeScript's type inference.
    // The TypeScript compiler cannot deduce the specific return types based solely on the input values,
    // so this approach ensures correct type association for each possible input.
    switch (creditContractName) {
        case "CreditLine":
            return await ethers.getContractFactory(creditContractName);
        case "ReceivableBackedCreditLine":
            return await ethers.getContractFactory(creditContractName);
        case "ReceivableFactoringCredit":
            return await ethers.getContractFactory(creditContractName);
        case "MockPoolCredit":
            return await ethers.getContractFactory(creditContractName);
        default:
            throw new Error("Invalid creditContractName");
    }
}

async function getCreditManagerContractFactory(
    creditManagerContractName: CreditManagerContractName,
) {
    // Note: All branches contain identical logic, which might seem unusual at first glance.
    // This structure is intentional and solely to satisfy TypeScript's type inference.
    // The TypeScript compiler cannot deduce the specific return types based solely on the input values,
    // so this approach ensures correct type association for each possible input.
    switch (creditManagerContractName) {
        case "BorrowerLevelCreditManager":
            return await ethers.getContractFactory(creditManagerContractName);
        case "ReceivableBackedCreditLineManager":
            return await ethers.getContractFactory(creditManagerContractName);
        case "ReceivableLevelCreditManager":
            return await ethers.getContractFactory(creditManagerContractName);
        default:
            throw new Error("Invalid creditManagerContractName");
    }
}

export function calcPrincipalDueForFullPeriods(
    unbilledPrincipal: BN,
    principalRateInBps: number,
    numPeriods: number,
): BN {
    return CONSTANTS.BP_FACTOR.pow(numPeriods)
        .sub(CONSTANTS.BP_FACTOR.sub(principalRateInBps).pow(numPeriods))
        .mul(unbilledPrincipal)
        .div(CONSTANTS.BP_FACTOR.pow(numPeriods));
}

export function calcPrincipalDueForPartialPeriod(
    unbilledPrincipal: BN,
    principalRateInBps: number,
    daysLeft: number | BN,
    totalDaysInFullPeriod: number | BN,
) {
    return unbilledPrincipal
        .mul(principalRateInBps)
        .mul(daysLeft)
        .div(CONSTANTS.BP_FACTOR.mul(totalDaysInFullPeriod));
}

export function calcYield(principal: BN, yieldInBps: number, days: number): BN {
    return principal
        .mul(yieldInBps)
        .mul(days)
        .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.DAYS_IN_A_YEAR));
}

export interface AccruedIncomes {
    protocolIncome: BN;
    poolOwnerIncome: BN;
    eaIncome: BN;
}

export function calcPoolFees(
    profit: BN,
    protocolFeeInBps: number,
    rewardRateInBpsForPoolOwner: number,
    rewardRateInBpsForEA: number,
): [AccruedIncomes, BN] {
    const protocolIncome = profit.mul(protocolFeeInBps).div(CONSTANTS.BP_FACTOR);
    const remainingProfit = profit.sub(protocolIncome);
    const poolOwnerIncome = remainingProfit
        .mul(rewardRateInBpsForPoolOwner)
        .div(CONSTANTS.BP_FACTOR);
    const eaIncome = remainingProfit.mul(rewardRateInBpsForEA).div(CONSTANTS.BP_FACTOR);
    const accruedIncomes: AccruedIncomes = {
        protocolIncome,
        poolOwnerIncome,
        eaIncome,
    };
    return [accruedIncomes, remainingProfit.sub(poolOwnerIncome).sub(eaIncome)];
}

export async function checkRedemptionRecordByLender(
    trancheVaultContract: TrancheVault,
    lender: SignerWithAddress,
    nextEpochIdToProcess: BN | number,
    numSharesRequested: BN = BN.from(0),
    principalRequested: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    totalAmountWithdrawn: BN = BN.from(0),
    delta: number = 0,
) {
    const redemptionRecord = await trancheVaultContract.lenderRedemptionRecords(lender.address);
    checkRedemptionRecord(
        redemptionRecord,
        nextEpochIdToProcess,
        numSharesRequested,
        principalRequested,
        totalAmountProcessed,
        totalAmountWithdrawn,
        delta,
    );
}

type RedemptionRecordStructOutput = [BN, BN, BN, BN, BN] & {
    nextEpochIdToProcess: BN;
    numSharesRequested: BN;
    principalRequested: BN;
    totalAmountProcessed: BN;
    totalAmountWithdrawn: BN;
};

export function checkRedemptionRecord(
    redemptionRecord: RedemptionRecordStructOutput,
    nextEpochIdToProcess: BN | number,
    numSharesRequested: BN = BN.from(0),
    principalRequested: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    totalAmountWithdrawn: BN = BN.from(0),
    delta: number = 0,
) {
    expect(redemptionRecord.nextEpochIdToProcess).to.be.closeTo(nextEpochIdToProcess, delta);
    expect(redemptionRecord.numSharesRequested).to.be.closeTo(numSharesRequested, delta);
    expect(redemptionRecord.principalRequested).to.be.closeTo(principalRequested, delta);
    expect(redemptionRecord.totalAmountProcessed).to.be.closeTo(totalAmountProcessed, delta);
    expect(redemptionRecord.totalAmountWithdrawn).to.be.closeTo(totalAmountWithdrawn, delta);
}
