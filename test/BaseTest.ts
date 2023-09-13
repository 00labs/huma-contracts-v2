import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { getNextDate, getNextMonth, toToken } from "./TestUtils";
import { EpochInfoStruct } from "../typechain-types/contracts/interfaces/IEpoch";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { ethers } from "hardhat";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    BaseTranchesPolicy,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    IPoolCredit,
    FirstLossCover,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    TrancheVault,
} from "../typechain-types";
import {
    CreditConfigStruct,
    CreditRecordStruct,
} from "../typechain-types/contracts/credit/interfaces/ICredit";

export type ProtocolContracts = [EvaluationAgentNFT, HumaConfig, MockToken];
export type PoolContracts = [
    PoolConfig,
    PlatformFeeManager,
    PoolVault,
    Calendar,
    FirstLossCover,
    BaseTranchesPolicy,
    Pool,
    EpochManager,
    TrancheVault,
    TrancheVault,
    IPoolCredit,
    BaseCreditFeeManager,
    BasePnLManager,
];
export type TranchesPolicyContractName = "FixedAprTranchesPolicy" | "RiskAdjustedTranchesPolicy";
export type CreditContractName =
    | "Credit"
    | "DynamicYieldCredit"
    | "ReceivableFactoringCredit"
    | "CreditFacility"
    | "CreditLine"
    | "ReceivableCredit"
    | "MockPoolCredit";

const CALENDAR_UNIT_DAY = 0;
const CALENDAR_UNIT_MONTH = 1;
const SENIOR_TRANCHE_INDEX = 0;
const JUNIOR_TRANCHE_INDEX = 1;
const PRICE_DECIMALS_FACTOR = 10n ** 18n;
const BP_FACTOR = BN.from(10000);
const SECONDS_IN_YEAR = 60 * 60 * 24 * 365;

export const CONSTANTS = {
    CALENDAR_UNIT_DAY,
    CALENDAR_UNIT_MONTH,
    SENIOR_TRANCHE_INDEX,
    JUNIOR_TRANCHE_INDEX,
    PRICE_DECIMALS_FACTOR,
    BP_FACTOR,
    SECONDS_IN_YEAR,
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
    await humaConfigContract.setTreasuryFee(2000);
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
): Promise<PoolContracts> {
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

    // const MockCredit = await ethers.getContractFactory("MockCredit");
    // const mockCreditContract = await MockCredit.deploy(poolConfig.address);
    // await mockCreditContract.deployed();

    const Credit = await getCreditContractFactory(creditContractName);
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
        poolOwner.getAddress(),
    );
    await poolConfigContract.renounceRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );

    await platformFeeManagerContract.initialize(poolConfigContract.address);
    await poolVaultContract.initialize(poolConfigContract.address);
    await poolOwnerAndEAFirstLossCoverContract.initialize(poolConfigContract.address);
    await tranchesPolicyContract.initialize(poolConfigContract.address);
    await poolContract.initialize(poolConfigContract.address);
    await epochManagerContract.initialize(poolConfigContract.address);
    await seniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Senior Tranche Vault",
        "STV",
        poolConfigContract.address,
        SENIOR_TRANCHE_INDEX,
    );
    await juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Junior Tranche Vault",
        "JTV",
        poolConfigContract.address,
        JUNIOR_TRANCHE_INDEX,
    );
    await creditContract.connect(poolOwner).initialize(poolConfigContract.address);
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

export async function setupPoolContracts(
    poolConfigContract: PoolConfig,
    eaNFTContract: EvaluationAgentNFT,
    mockTokenContract: MockToken,
    poolOwnerAndEAFirstLossCoverContract: FirstLossCover,
    poolVaultContract: PoolVault,
    poolContract: Pool,
    juniorTrancheVaultContract: TrancheVault,
    seniorTrancheVaultContract: TrancheVault,
    creditContract: IPoolCredit,
    poolOwner: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
): Promise<void> {
    await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000_000));
    await poolConfigContract.connect(poolOwner).setMaxCreditLine(toToken(10_000_000));

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());
    await poolConfigContract.connect(poolOwner).setPoolOwnerRewardsAndLiquidity(625, 10);

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
    await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(1875, 10);

    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwner)
        .setOperator(poolOwnerTreasury.getAddress(), {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });
    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwner)
        .setOperator(evaluationAgent.getAddress(), {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });

    let role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());

    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolOwnerAndEAFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(100_000_000));
    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwnerTreasury)
        .addCover(toToken(10_000_000));

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolOwnerAndEAFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(100_000_000));
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
            .addApprovedLender(accounts[i].getAddress());
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress());
        await mockTokenContract
            .connect(accounts[i])
            .approve(poolVaultContract.address, ethers.constants.MaxUint256);
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        await mockTokenContract.mint(accounts[i].getAddress(), toToken(100_000_000));
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
    evaluationAgent: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
): Promise<PoolContracts> {
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
        creditContractName,
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
        accounts,
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

export function getNextDueDate(
    calendarUnit: number,
    lastDate: number | BN,
    currentDate: number | BN,
    periodDuration: number | BN,
): number[] {
    switch (calendarUnit) {
        case CONSTANTS.CALENDAR_UNIT_DAY:
            return getNextDate(Number(lastDate), Number(currentDate), Number(periodDuration));
        case CONSTANTS.CALENDAR_UNIT_MONTH:
            return getNextMonth(Number(lastDate), Number(currentDate), Number(periodDuration));
        default:
            throw Error("Unrecognized calendar unit");
    }
}

function calcProfitForFixedAprPolicy(
    profit: BN,
    assets: BN[],
    lastUpdateTS: number,
    currentTS: number,
    deployedAssets: BN,
    yieldInBps: number,
): BN[] {
    const totalAssets = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
    );
    const seniorDeployedAssets = deployedAssets
        .mul(assets[CONSTANTS.SENIOR_TRANCHE_INDEX])
        .div(totalAssets);
    let seniorProfit = BN.from(0);
    if (currentTS > lastUpdateTS) {
        seniorProfit = seniorDeployedAssets
            .mul(BN.from(currentTS).sub(BN.from(lastUpdateTS)))
            .mul(BN.from(yieldInBps))
            .div(CONSTANTS.SECONDS_IN_YEAR)
            .div(CONSTANTS.BP_FACTOR);
    }
    seniorProfit = seniorProfit.gt(profit) ? profit : seniorProfit;
    const juniorProfit = profit.sub(seniorProfit);

    return [
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(seniorProfit),
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(juniorProfit),
    ];
}

function calcProfitForRiskAdjustedPolicy(profit: BN, assets: BN[], riskAdjustment: BN): BN[] {
    const totalAssets = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
    );

    let seniorProfit = profit.mul(assets[CONSTANTS.SENIOR_TRANCHE_INDEX]).div(totalAssets);
    const adjustedProfit = seniorProfit.mul(riskAdjustment).div(CONSTANTS.BP_FACTOR);
    seniorProfit = seniorProfit.sub(adjustedProfit);

    return [
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(seniorProfit),
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(profit).sub(seniorProfit),
    ];
}

function calcLoss(loss: BN, assets: BN[]): BN[][] {
    const juniorLoss = loss.gt(assets[CONSTANTS.JUNIOR_TRANCHE_INDEX])
        ? assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        : loss;
    const seniorLoss = loss.sub(juniorLoss);

    return [
        [
            assets[CONSTANTS.SENIOR_TRANCHE_INDEX].sub(seniorLoss),
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].sub(juniorLoss),
        ],
        [seniorLoss, juniorLoss],
    ];
}

function calcLossRecovery(lossRecovery: BN, assets: BN[], losses: BN[]): [BN, BN[], BN[]] {
    const seniorRecovery = lossRecovery.gt(losses[CONSTANTS.SENIOR_TRANCHE_INDEX])
        ? losses[CONSTANTS.SENIOR_TRANCHE_INDEX]
        : lossRecovery;
    lossRecovery = lossRecovery.sub(seniorRecovery);
    const juniorRecovery = lossRecovery.gt(losses[CONSTANTS.JUNIOR_TRANCHE_INDEX])
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

export const PnLCalculator = {
    calcProfitForFixedAprPolicy,
    calcProfitForRiskAdjustedPolicy,
    calcLoss,
    calcLossRecovery,
};

export function checkEpochInfo(
    epochInfo: EpochInfoStruct,
    epochId: BN,
    totalShareRequested: BN,
    totalShareProcessed: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
): void {
    expect(epochInfo.epochId).to.equal(epochId);
    expect(epochInfo.totalShareRequested).to.equal(totalShareRequested);
    expect(epochInfo.totalShareProcessed).to.equal(totalShareProcessed);
    expect(epochInfo.totalAmountProcessed).to.equal(totalAmountProcessed);
}

export function checkCreditConfig(
    creditConfig: CreditConfigStruct,
    creditLimit: BN,
    committedAmount: BN,
    calendarUnit: number,
    periodDuration: number,
    numOfPeriods: number,
    yieldInBps: number,
    revolving: boolean,
    receivableBacked: boolean,
    borrowerLevelCredit: boolean,
    exclusive: boolean,
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

export function checkTwoCreditRecords(
    preCreditRecord: CreditRecordStruct,
    creditRecord: CreditRecordStruct,
) {
    expect(creditRecord.unbilledPrincipal).to.equal(preCreditRecord.unbilledPrincipal);
    expect(creditRecord.nextDueDate).to.equal(preCreditRecord.nextDueDate);
    expect(creditRecord.totalDue).to.equal(preCreditRecord.totalDue);
    expect(creditRecord.yieldDue).to.equal(preCreditRecord.yieldDue);
    expect(creditRecord.feesDue).to.equal(preCreditRecord.feesDue);
    expect(creditRecord.missedPeriods).to.equal(preCreditRecord.missedPeriods);
    expect(creditRecord.remainingPeriods).to.equal(preCreditRecord.remainingPeriods);
    expect(creditRecord.state).to.equal(preCreditRecord.state);
}

export function checkCreditRecord(
    creditRecord: CreditRecordStruct,
    unbilledPrincipal: BN,
    nextDueDate: number,
    totalDue: BN,
    yieldDue: BN,
    feesDue: BN,
    missedPeriods: number,
    remainingPeriods: number,
    state: number,
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

export function checkPnLTracker(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pnlTracker: any,
    profitRate: BN,
    lossRate: BN,
    pnlLastUpdated: number,
    accruedProfit: BN,
    accruedLoss: BN,
    accruedLossRecovery: BN,
) {
    expect(pnlTracker.profitRate).to.equal(profitRate);
    expect(pnlTracker.lossRate).to.equal(lossRate);
    expect(pnlTracker.pnlLastUpdated).to.equal(pnlLastUpdated);
    expect(pnlTracker.accruedProfit).to.equal(accruedProfit);
    expect(pnlTracker.accruedLoss).to.equal(accruedLoss);
    expect(pnlTracker.accruedLossRecovery).to.equal(accruedLossRecovery);
}

export function printCreditRecord(name: string, creditRecord: CreditRecordStruct) {
    // console.log(`${name}[ \
    // unbilledPrincipal: ${creditRecord.unbilledPrincipal}, \
    // nextDueDate: ${creditRecord.nextDueDate}, \
    // totalDue: ${creditRecord.totalDue}, \
    // yieldDue: ${creditRecord.yieldDue}, \
    // feesDue: ${creditRecord.feesDue}, \
    // missedPeriods: ${creditRecord.missedPeriods}, \
    // remainingPeriods: ${creditRecord.remainingPeriods}, \
    // state: ${creditRecord.state}, \
    // ]`);
}

async function getTranchesPolicyContractFactory(
    tranchesPolicyContractName: TranchesPolicyContractName,
) {
    // Note: Both branches contain identical logic, which might seem unusual at first glance.
    // This structure is intentional and solely to satisfy TypeScript's type inference.
    // The TypeScript compiler cannot deduce the specific return types based solely on the input values,
    // so this approach ensures correct type association for each possible input.
    switch (tranchesPolicyContractName) {
        case "FixedAprTranchesPolicy":
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
        case "Credit":
            return await ethers.getContractFactory(creditContractName);
        case "DynamicYieldCredit":
            return await ethers.getContractFactory(creditContractName);
        case "ReceivableFactoringCredit":
            return await ethers.getContractFactory(creditContractName);
        case "CreditFacility":
            return await ethers.getContractFactory(creditContractName);
        case "CreditLine":
            return await ethers.getContractFactory(creditContractName);
        case "ReceivableCredit":
            return await ethers.getContractFactory(creditContractName);
        case "MockPoolCredit":
            return await ethers.getContractFactory(creditContractName);
        default:
            throw new Error("Invalid tranchesPolicyContractName");
    }
}
