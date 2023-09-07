import { expect } from "chai";
import { getNextDate, getNextMonth, toToken } from "./TestUtils";
import { EpochInfoStruct } from "../typechain-types/contracts/interfaces/IEpoch";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
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
    LossCoverer,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    TrancheVault,
} from "../typechain-types";

export type ProtocolContracts = [EvaluationAgentNFT, HumaConfig, MockToken];
export type PoolContracts = [
    PoolConfig,
    PlatformFeeManager,
    PoolVault,
    Calendar,
    LossCoverer,
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

const CALENDAR_UNIT_DAY = 0n;
const CALENDAR_UNIT_MONTH = 1n;
const SENIOR_TRANCHE_INDEX = 0;
const JUNIOR_TRANCHE_INDEX = 1;
const PRICE_DECIMALS_FACTOR = 10n ** 18n;
const BP_FACTOR = 10000n;
const SECONDS_IN_YEAR = 60n * 60n * 24n * 365n;

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
    protocolOwner: HardhatEthersSigner,
    treasury: HardhatEthersSigner,
    eaServiceAccount: HardhatEthersSigner,
    pdsServiceAccount: HardhatEthersSigner,
    poolOwner: HardhatEthersSigner,
): Promise<ProtocolContracts> {
    // Deploy EvaluationAgentNFT
    const EvaluationAgentNFT = await ethers.getContractFactory("EvaluationAgentNFT");
    const eaNFTContract = await EvaluationAgentNFT.deploy();
    await eaNFTContract.waitForDeployment();

    // Deploy HumaConfig
    const HumaConfig = await ethers.getContractFactory("HumaConfig");
    let humaConfigContract = await HumaConfig.deploy();
    await humaConfigContract.waitForDeployment();

    await humaConfigContract.setHumaTreasury(treasury.getAddress());
    await humaConfigContract.setTreasuryFee(2000);
    await humaConfigContract.setEANFTContractAddress(eaNFTContract.getAddress());
    await humaConfigContract.setEAServiceAccount(eaServiceAccount.getAddress());
    await humaConfigContract.setPDSServiceAccount(pdsServiceAccount.getAddress());

    await humaConfigContract.addPauser(protocolOwner.getAddress());
    await humaConfigContract.addPauser(poolOwner.getAddress());

    await humaConfigContract.transferOwnership(protocolOwner.getAddress());
    if (await humaConfigContract.connect(protocolOwner).paused())
        await humaConfigContract.connect(protocolOwner).unpause();

    const MockToken = await ethers.getContractFactory("MockToken");
    const mockTokenContract = await MockToken.deploy();
    await mockTokenContract.waitForDeployment();

    await humaConfigContract
        .connect(protocolOwner)
        .setLiquidityAsset(mockTokenContract.getAddress(), true);

    return [eaNFTContract, humaConfigContract, mockTokenContract];
}

export async function deployPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: HardhatEthersSigner,
    poolOwner: HardhatEthersSigner,
    creditContractName: CreditContractName,
): Promise<PoolContracts> {
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const poolConfigContract = await PoolConfig.deploy();
    await poolConfigContract.waitForDeployment();

    const PlatformFeeManager = await ethers.getContractFactory("PlatformFeeManager");
    const platformFeeManagerContract = await PlatformFeeManager.deploy(
        poolConfigContract.getAddress(),
    );
    await platformFeeManagerContract.waitForDeployment();

    const PoolVault = await ethers.getContractFactory("PoolVault");
    const poolVaultContract = await PoolVault.deploy(poolConfigContract.getAddress());
    await poolVaultContract.waitForDeployment();

    const LossCoverer = await ethers.getContractFactory("LossCoverer");
    const poolOwnerAndEALossCovererContract = await LossCoverer.deploy(
        poolConfigContract.getAddress(),
    );
    await poolOwnerAndEALossCovererContract.waitForDeployment();

    const TranchesPolicy = await getTranchesPolicyContractFactory(tranchesPolicyContractName);
    const tranchesPolicyContract = await TranchesPolicy.deploy(poolConfigContract.getAddress());
    await tranchesPolicyContract.waitForDeployment();

    const Pool = await ethers.getContractFactory("Pool");
    const poolContract = await Pool.deploy(poolConfigContract.getAddress());
    await poolContract.waitForDeployment();

    const EpochManager = await ethers.getContractFactory("EpochManager");
    const epochManagerContract = await EpochManager.deploy(poolConfigContract.getAddress());
    await epochManagerContract.waitForDeployment();

    const TrancheVault = await ethers.getContractFactory("TrancheVault");
    const seniorTrancheVaultContract = await TrancheVault.deploy();
    await seniorTrancheVaultContract.waitForDeployment();
    const juniorTrancheVaultContract = await TrancheVault.deploy();
    await juniorTrancheVaultContract.waitForDeployment();

    const Calendar = await ethers.getContractFactory("Calendar");
    const calendarContract = await Calendar.deploy();
    await calendarContract.waitForDeployment();

    // const MockCredit = await ethers.getContractFactory("MockCredit");
    // const mockCreditContract = await MockCredit.deploy(poolConfigContract.getAddress());
    // await mockCreditContract.waitForDeployment();

    const Credit = await getCreditContractFactory(creditContractName);
    const creditContract = await Credit.deploy();
    await creditContract.waitForDeployment();

    const BaseCreditFeeManager = await ethers.getContractFactory("BaseCreditFeeManager");
    const creditFeeManagerContract = await BaseCreditFeeManager.deploy(
        poolConfigContract.getAddress(),
    );
    await creditFeeManagerContract.waitForDeployment();

    const CreditPnLManager = await ethers.getContractFactory("LinearMarkdownPnLManager");
    const creditPnlManagerContract = await CreditPnLManager.deploy(
        poolConfigContract.getAddress(),
    );
    await creditPnlManagerContract.waitForDeployment();

    await poolConfigContract.initialize("Test Pool", [
        humaConfigContract.getAddress(),
        mockTokenContract.getAddress(),
        platformFeeManagerContract.getAddress(),
        poolVaultContract.getAddress(),
        calendarContract.getAddress(),
        poolOwnerAndEALossCovererContract.getAddress(),
        tranchesPolicyContract.getAddress(),
        poolContract.getAddress(),
        epochManagerContract.getAddress(),
        seniorTrancheVaultContract.getAddress(),
        juniorTrancheVaultContract.getAddress(),
        creditContract.getAddress(),
        creditFeeManagerContract.getAddress(),
        creditPnlManagerContract.getAddress(),
    ]);

    await poolConfigContract.grantRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.getAddress(),
    );
    await poolConfigContract.renounceRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );

    await platformFeeManagerContract.connect(poolOwner).updatePoolConfigData();
    await poolVaultContract.connect(poolOwner).updatePoolConfigData();
    await poolOwnerAndEALossCovererContract.connect(poolOwner).updatePoolConfigData();
    await poolContract.connect(poolOwner).updatePoolConfigData();
    await epochManagerContract.connect(poolOwner).updatePoolConfigData();
    await seniorTrancheVaultContract
        .connect(poolOwner)
        .initialize(
            "Senior Tranche Vault",
            "STV",
            poolConfigContract.getAddress(),
            SENIOR_TRANCHE_INDEX,
        );
    await juniorTrancheVaultContract
        .connect(poolOwner)
        .initialize(
            "Junior Tranche Vault",
            "JTV",
            poolConfigContract.getAddress(),
            JUNIOR_TRANCHE_INDEX,
        );
    await creditContract.connect(poolOwner).initialize(poolConfigContract.getAddress());
    await creditFeeManagerContract.connect(poolOwner).updatePoolConfigData();
    await creditPnlManagerContract.connect(poolOwner).updatePoolConfigData();

    return [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEALossCovererContract,
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
    poolOwnerAndEALossCovererContract: LossCoverer,
    poolVaultContract: PoolVault,
    poolContract: Pool,
    juniorTrancheVaultContract: TrancheVault,
    seniorTrancheVaultContract: TrancheVault,
    creditContract: IPoolCredit,
    poolOwner: HardhatEthersSigner,
    evaluationAgent: HardhatEthersSigner,
    poolOwnerTreasury: HardhatEthersSigner,
    poolOperator: HardhatEthersSigner,
    accounts: HardhatEthersSigner[],
): Promise<void> {
    await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000_000));
    await poolConfigContract.connect(poolOwner).setMaxCreditLine(toToken(10_000_000));

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());
    await poolConfigContract.connect(poolOwner).setPoolOwnerRewardsAndLiquidity(625, 10);

    const tx = await eaNFTContract.mintNFT(evaluationAgent.getAddress());
    await tx.wait();
    const eventFilter = eaNFTContract.filters.NFTGenerated;
    const nftGeneratedEvents = await eaNFTContract.queryFilter(eventFilter);
    const eaNFTTokenId = nftGeneratedEvents[0].args.tokenId;
    await poolConfigContract
        .connect(poolOwner)
        .setEvaluationAgent(eaNFTTokenId, evaluationAgent.getAddress());
    await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(1875, 10);

    await poolOwnerAndEALossCovererContract
        .connect(poolOwner)
        .setOperator(poolOwnerTreasury.getAddress(), {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });
    await poolOwnerAndEALossCovererContract
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
        .approve(poolOwnerAndEALossCovererContract.getAddress(), ethers.MaxUint256);
    await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(100_000_000));
    await poolOwnerAndEALossCovererContract
        .connect(poolOwnerTreasury)
        .addCover(toToken(10_000_000));

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolOwnerAndEALossCovererContract.getAddress(), ethers.MaxUint256);
    await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(100_000_000));
    await poolOwnerAndEALossCovererContract.connect(evaluationAgent).addCover(toToken(10_000_000));

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
            .approve(poolVaultContract.getAddress(), ethers.MaxUint256);
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.getAddress(), ethers.MaxUint256);
        await mockTokenContract.mint(accounts[i].getAddress(), toToken(100_000_000));
    }
}

export async function deployAndSetupPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken,
    eaNFTContract: EvaluationAgentNFT,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: HardhatEthersSigner,
    poolOwner: HardhatEthersSigner,
    creditContractName: CreditContractName,
    evaluationAgent: HardhatEthersSigner,
    poolOwnerTreasury: HardhatEthersSigner,
    poolOperator: HardhatEthersSigner,
    accounts: HardhatEthersSigner[],
): Promise<PoolContracts> {
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
        poolOwnerAndEAlossCovererContract,
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
        poolOwnerAndEAlossCovererContract,
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
    calendarUnit: bigint,
    lastDate: number | bigint,
    currentDate: number | bigint,
    periodDuration: number | bigint,
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
    profit: bigint,
    assets: bigint[],
    lastUpdateTS: number,
    currentTS: number,
    deployedAssets: bigint,
    yieldInBps: bigint,
): bigint[] {
    const totalAssets =
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX] + assets[CONSTANTS.JUNIOR_TRANCHE_INDEX];
    const seniorDeployedAssets =
        (deployedAssets * assets[CONSTANTS.SENIOR_TRANCHE_INDEX]) / totalAssets;
    let seniorProfit = 0n;
    if (currentTS > lastUpdateTS) {
        seniorProfit =
            (seniorDeployedAssets * (BigInt(currentTS) - BigInt(lastUpdateTS)) * yieldInBps) /
            CONSTANTS.SECONDS_IN_YEAR /
            CONSTANTS.BP_FACTOR;
    }
    seniorProfit = seniorProfit > profit ? profit : seniorProfit;
    const juniorProfit = profit - seniorProfit;

    return [
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX] + seniorProfit,
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX] + juniorProfit,
    ];
}

function calcProfitForRiskAdjustedPolicy(
    profit: bigint,
    assets: bigint[],
    riskAdjustment: bigint,
): bigint[] {
    const totalAssets =
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX] + assets[CONSTANTS.JUNIOR_TRANCHE_INDEX];

    let seniorProfit = (profit * assets[CONSTANTS.SENIOR_TRANCHE_INDEX]) / totalAssets;
    const adjustedProfit = (seniorProfit * riskAdjustment) / CONSTANTS.BP_FACTOR;
    seniorProfit = seniorProfit - adjustedProfit;

    return [
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX] + seniorProfit,
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX] + profit - seniorProfit,
    ];
}

function calcLoss(loss: bigint, assets: bigint[]): bigint[][] {
    const juniorLoss =
        loss > assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
            ? assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
            : loss;
    const seniorLoss = loss - juniorLoss;

    return [
        [
            assets[CONSTANTS.SENIOR_TRANCHE_INDEX] - seniorLoss,
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX] - juniorLoss,
        ],
        [seniorLoss, juniorLoss],
    ];
}

function calcLossRecovery(
    lossRecovery: bigint,
    assets: bigint[],
    losses: bigint[],
): [bigint, bigint[], bigint[]] {
    const seniorRecovery =
        lossRecovery > losses[CONSTANTS.SENIOR_TRANCHE_INDEX]
            ? losses[CONSTANTS.SENIOR_TRANCHE_INDEX]
            : lossRecovery;
    lossRecovery = lossRecovery - seniorRecovery;
    const juniorRecovery =
        lossRecovery > losses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
            ? losses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
            : lossRecovery;
    lossRecovery = lossRecovery - juniorRecovery;

    return [
        lossRecovery,
        [
            assets[CONSTANTS.SENIOR_TRANCHE_INDEX] + seniorRecovery,
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX] + juniorRecovery,
        ],
        [
            losses[CONSTANTS.SENIOR_TRANCHE_INDEX] - seniorRecovery,
            losses[CONSTANTS.JUNIOR_TRANCHE_INDEX] - juniorRecovery,
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
    epochId: bigint,
    totalShareRequested: bigint,
    totalShareProcessed: bigint = 0n,
    totalAmountProcessed: bigint = 0n,
): void {
    expect(epochInfo.epochId).to.equal(epochId);
    expect(epochInfo.totalShareRequested).to.equal(totalShareRequested);
    expect(epochInfo.totalShareProcessed).to.equal(totalShareProcessed);
    expect(epochInfo.totalAmountProcessed).to.equal(totalAmountProcessed);
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
