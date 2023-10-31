import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    BaseTranchesPolicy,
    Calendar,
    CreditFeeManager,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    IPoolCredit,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    ProfitEscrow,
    Receivable,
    TrancheVault,
} from "../typechain-types";
import { FirstLossCoverConfigStruct } from "../typechain-types/contracts/PoolConfig.sol/PoolConfig";
import {
    CreditConfigStruct,
    CreditRecordStruct,
} from "../typechain-types/contracts/credit/Credit";
import { EpochInfoStruct } from "../typechain-types/contracts/interfaces/IEpoch";
import { minBigNumber, sumBNArray, toToken } from "./TestUtils";

export type ProtocolContracts = [EvaluationAgentNFT, HumaConfig, MockToken];
export type PoolContracts = [
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Calendar,
    FirstLossCover,
    FirstLossCover,
    ProfitEscrow,
    BaseTranchesPolicy,
    Pool,
    EpochManager,
    TrancheVault,
    TrancheVault,
    IPoolCredit,
    CreditFeeManager,
    Receivable,
];
export type TranchesPolicyContractName =
    | "FixedSeniorYieldTranchePolicy"
    | "RiskAdjustedTranchesPolicy";
export type CreditContractName = "CreditLine" | "MockPoolCredit";

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

const SENIOR_TRANCHE = 0;
const JUNIOR_TRANCHE = 1;
const DEFAULT_DECIMALS_FACTOR = BN.from(10).pow(18);
const BP_FACTOR = BN.from(10000);
const SECONDS_IN_YEAR = 60 * 60 * 24 * 365;
const BORROWER_FIRST_LOSS_COVER_INDEX = 0;
const AFFILIATE_FIRST_LOSS_COVER_INDEX = 1;

export const CONSTANTS = {
    SENIOR_TRANCHE,
    JUNIOR_TRANCHE,
    DEFAULT_DECIMALS_FACTOR,
    BP_FACTOR,
    SECONDS_IN_YEAR,
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
    const ProfitEscrow = await ethers.getContractFactory("ProfitEscrow");
    const affiliateFirstLossCoverProfitEscrowContract = await ProfitEscrow.deploy();
    await affiliateFirstLossCoverProfitEscrowContract.deployed();

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

    const CreditFeeManager = await ethers.getContractFactory("CreditFeeManager");
    const creditFeeManagerContract = await CreditFeeManager.deploy();
    await creditFeeManagerContract.deployed();

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
        creditFeeManagerContract.address,
    ]);
    await poolConfigContract.setFirstLossCover(
        BORROWER_FIRST_LOSS_COVER_INDEX,
        borrowerFirstLossCoverContract.address,
        {
            coverRateInBps: 0,
            coverCap: 0,
            liquidityCap: 0,
            maxPercentOfPoolValueInBps: 0,
            riskYieldMultiplier: 0,
        },
        ethers.constants.AddressZero,
    );
    await poolConfigContract.setFirstLossCover(
        AFFILIATE_FIRST_LOSS_COVER_INDEX,
        affiliateFirstLossCoverContract.address,
        {
            coverRateInBps: 0,
            coverCap: 0,
            liquidityCap: 0,
            maxPercentOfPoolValueInBps: 0,
            riskYieldMultiplier: 20000,
        },
        affiliateFirstLossCoverProfitEscrowContract.address,
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
    await affiliateFirstLossCoverProfitEscrowContract["initialize(address,address)"](
        affiliateFirstLossCoverContract.address,
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
    await creditFeeManagerContract.initialize(poolConfigContract.address);

    return [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        affiliateFirstLossCoverProfitEscrowContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        receivableContract,
    ];
}

export async function setupPoolContracts(
    poolConfigContract: PoolConfig,
    eaNFTContract: EvaluationAgentNFT,
    mockTokenContract: MockToken,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
    poolSafeContract: PoolSafe,
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
    const poolLiquidityCap = toToken(1_000_000_000);
    await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(poolLiquidityCap);
    await poolConfigContract.connect(poolOwner).setMaxCreditLine(toToken(10_000_000));

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());

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

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(1_000_000_000));
    const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
        .mul(poolLiquidityCap)
        .div(CONSTANTS.BP_FACTOR);
    await juniorTrancheVaultContract
        .connect(evaluationAgent)
        .makeInitialDeposit(evaluationAgentLiquidity);

    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract
        .connect(evaluationAgent)
        .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
    const firstLossCoverageInBps = 100;
    await affiliateFirstLossCoverContract
        .connect(poolOwner)
        .setCoverProvider(poolOwnerTreasury.getAddress(), {
            poolCapCoverageInBps: firstLossCoverageInBps,
            poolValueCoverageInBps: firstLossCoverageInBps,
        });
    await affiliateFirstLossCoverContract
        .connect(poolOwner)
        .setCoverProvider(evaluationAgent.getAddress(), {
            poolCapCoverageInBps: firstLossCoverageInBps,
            poolValueCoverageInBps: firstLossCoverageInBps,
        });

    const role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());

    await affiliateFirstLossCoverContract
        .connect(poolOwnerTreasury)
        .depositCover(poolLiquidityCap.mul(firstLossCoverageInBps).div(CONSTANTS.BP_FACTOR));
    await affiliateFirstLossCoverContract
        .connect(evaluationAgent)
        .depositCover(poolLiquidityCap.mul(firstLossCoverageInBps).div(CONSTANTS.BP_FACTOR));
    await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true);

    // Set pool epoch window to 3 days for testing purposes
    await poolConfigContract.connect(poolOwner).setPoolPayPeriod(3);

    await poolContract.connect(poolOwner).enablePool();
    const expectedInitialLiquidity = poolOwnerLiquidity.add(evaluationAgentLiquidity);
    expect(await poolContract.totalAssets()).to.equal(expectedInitialLiquidity);
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(expectedInitialLiquidity);
    expect(await juniorTrancheVaultContract.totalSupply()).to.equal(expectedInitialLiquidity);
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
            .approve(poolSafeContract.address, ethers.constants.MaxUint256);
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        await mockTokenContract.mint(accounts[i].getAddress(), toToken(1_000_000_000));
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
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        affiliateFirstLossCoverProfitEscrowContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        receivableContract,
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
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        affiliateFirstLossCoverProfitEscrowContract,
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
    );

    return [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        affiliateFirstLossCoverProfitEscrowContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        receivableContract,
    ];
}

function calcProfitForFixedSeniorYieldPolicy(
    profit: BN,
    assets: BN[],
    lastUpdateTS: number,
    currentTS: number,
    deployedAssets: BN,
    yieldInBps: number,
): BN[] {
    const totalAssets = assets[CONSTANTS.SENIOR_TRANCHE].add(assets[CONSTANTS.JUNIOR_TRANCHE]);
    const seniorDeployedAssets = deployedAssets
        .mul(assets[CONSTANTS.SENIOR_TRANCHE])
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
        assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit),
        assets[CONSTANTS.JUNIOR_TRANCHE].add(juniorProfit),
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
            info.asset.mul(await info.config.riskYieldMultiplier),
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
}

async function calcLossCover(loss: BN, firstLossCoverInfo: FirstLossCoverInfo): Promise<BN[]> {
    const coveredAmount = minBigNumber(
        loss.mul(await firstLossCoverInfo.config.coverRateInBps).div(CONSTANTS.BP_FACTOR),
        BN.from(await firstLossCoverInfo.config.coverCap),
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
    for (const coveredLoss of lossesCoveredByFirstLossCovers) {
        [lossRecovery, recoveredAmount] = calcLossRecoveryForFirstLossCover(
            coveredLoss,
            lossRecovery,
        );
        lossRecoveredInFirstLossCovers.push(recoveredAmount);
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
    riskAdjustment: BN,
    firstLossCoverInfos: FirstLossCoverInfo[],
): Promise<[BN[], BN[], BN[], BN[]]> {
    const assetsAfterProfit = calcProfitForRiskAdjustedPolicy(profit, assets, riskAdjustment);
    const [juniorProfitAfterFirstLossCoverProfitDistribution, profitsForFirstLossCovers] =
        await PnLCalculator.calcProfitForFirstLossCovers(
            assetsAfterProfit[CONSTANTS.JUNIOR_TRANCHE].sub(assets[CONSTANTS.JUNIOR_TRANCHE]),
            assets[CONSTANTS.JUNIOR_TRANCHE],
            firstLossCoverInfos,
        );
    const [assetsAfterLoss, remainingLosses, lossesCoveredByFirstLossCovers] =
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
    const [, assetsAfterRecovery, lossesAfterRecovery, lossRecoveredInFirstLossCovers] =
        await PnLCalculator.calcLossRecovery(
            lossRecovery,
            assetsAfterLoss,
            remainingLosses,
            lossesCoveredByFirstLossCovers,
        );
    return [
        assetsAfterRecovery,
        lossesAfterRecovery,
        profitsForFirstLossCovers,
        lossRecoveredInFirstLossCovers,
    ];
}

export const PnLCalculator = {
    calcProfitForFixedSeniorYieldPolicy,
    calcProfitForRiskAdjustedPolicy,
    calcProfitForFirstLossCovers,
    calcLoss,
    calcLossRecovery,
    calcRiskAdjustedProfitAndLoss,
};

export function checkEpochInfo(
    epochInfo: EpochInfoStruct,
    epochId: BN,
    totalSharesRequested: BN,
    totalSharesProcessed: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    delta: number = 0,
): void {
    expect(epochInfo.epochId).to.equal(epochId);
    expect(epochInfo.totalSharesRequested).to.be.closeTo(totalSharesRequested, delta);
    expect(epochInfo.totalSharesProcessed).to.be.closeTo(totalSharesProcessed, delta);
    expect(epochInfo.totalAmountProcessed).to.be.closeTo(totalAmountProcessed, delta);
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

    async checkSeniorCurrentEpochInfo(
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        return await this.checkCurrentEpochInfo(
            this.seniorTrancheVaultContract,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkJuniorCurrentEpochInfo(
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        return await this.checkCurrentEpochInfo(
            this.juniorTrancheVaultContract,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkSeniorEpochInfoById(
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        await this.checkEpochInfoById(
            this.seniorTrancheVaultContract,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkJuniorEpochInfoById(
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        await this.checkEpochInfoById(
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
        const epoch = await trancheContract.epochInfoByEpochId(epochId);
        checkEpochInfo(epoch, BN.from(0), BN.from(0), BN.from(0), BN.from(0));
        return epochId;
    }

    private async checkCurrentEpochInfo(
        trancheContract: TrancheVault,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        const epochId = await this.epochManagerContract.currentEpochId();
        const epoch = await trancheContract.epochInfoByEpochId(epochId);
        checkEpochInfo(epoch, epochId, sharesRequested, sharesProcessed, amountProcessed, delta);
        return epochId;
    }

    private async checkEpochInfoById(
        trancheContract: TrancheVault,
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        const epoch = await trancheContract.epochInfoByEpochId(epochId);
        checkEpochInfo(epoch, epochId, sharesRequested, sharesProcessed, amountProcessed, delta);
    }
}

export function checkCreditConfig(
    creditConfig: CreditConfigStruct,
    creditLimit: BN,
    committedAmount: BN,
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
    expect(creditRecord.nextDue).to.equal(preCreditRecord.nextDue);
    expect(creditRecord.yieldDue).to.equal(preCreditRecord.yieldDue);
    expect(creditRecord.missedPeriods).to.equal(preCreditRecord.missedPeriods);
    expect(creditRecord.remainingPeriods).to.equal(preCreditRecord.remainingPeriods);
    expect(creditRecord.state).to.equal(preCreditRecord.state);
}

export function checkCreditRecord(
    creditRecord: CreditRecordStruct,
    unbilledPrincipal: BN,
    nextDueDate: number,
    nextDue: BN,
    yieldDue: BN,
    missedPeriods: number,
    remainingPeriods: number,
    state: number,
) {
    expect(creditRecord.unbilledPrincipal).to.equal(unbilledPrincipal);
    expect(creditRecord.nextDueDate).to.equal(nextDueDate);
    expect(creditRecord.nextDue).to.equal(nextDue);
    expect(creditRecord.yieldDue).to.equal(yieldDue);
    expect(creditRecord.missedPeriods).to.equal(missedPeriods);
    expect(creditRecord.remainingPeriods).to.equal(remainingPeriods);
    expect(creditRecord.state).to.equal(state);
}

export function checkCreditLoss(
    // creditLoss: CreditLossStructOutput,
    totalAccruedLoss: BN,
    totalLossRecovery: BN,
    delta = 0,
) {
    // expect(creditLoss.totalAccruedLoss).to.be.closeTo(totalAccruedLoss, delta);
    // expect(creditLoss.totalLossRecovery).to.be.closeTo(totalLossRecovery, delta);
}

export function checkTwoCreditLosses() {
    // preCreditLoss: CreditLossStructOutput,
    // creditLoss: CreditLossStructOutput,
    // expect(preCreditLoss.totalAccruedLoss).to.equal(creditLoss.totalAccruedLoss);
    // expect(preCreditLoss.totalLossRecovery).to.equal(creditLoss.totalLossRecovery);
}

export function printCreditRecord(name: string, creditRecord: CreditRecordStruct) {
    console.log(
        `${name}[
            unbilledPrincipal: ${creditRecord.unbilledPrincipal},
            nextDueDate: ${creditRecord.nextDueDate},
            nextDue: ${creditRecord.nextDue},
            yieldDue: ${creditRecord.yieldDue},
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
        case "MockPoolCredit":
            return await ethers.getContractFactory(creditContractName);
        default:
            throw new Error("Invalid tranchesPolicyContractName");
    }
}
