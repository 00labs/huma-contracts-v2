import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";

import { toToken } from "../test/TestUtils";
import {
    BaseTranchesPolicy,
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
    TrancheVault,
} from "../typechain-types";
import { deploy } from "./deployUtils";
export type CreditContractType = MockPoolCredit | CreditLine;
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
    Receivable,
];
export type TranchesPolicyContractName =
    | "FixedSeniorYieldTranchePolicy"
    | "RiskAdjustedTranchesPolicy";
export type CreditContractName = "CreditLine" | "MockPoolCredit";

export enum PayPeriodDuration {
    Monthly,
    Quarterly,
    SemiAnnually,
}

export enum CreditState {
    Deleted,
    Requested,
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
const SECONDS_IN_YEAR = 60 * 60 * 24 * 365;
const BORROWER_FIRST_LOSS_COVER_INDEX = 0;
const AFFILIATE_FIRST_LOSS_COVER_INDEX = 1;
const PERIOD_DURATION_MONTHLY = 0;
const PERIOD_DURATION_QUARTERLY = 1;
const PERIOD_DURATION_SEMI_ANNUALLY = 2;

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
    SECONDS_IN_YEAR,
    BORROWER_FIRST_LOSS_COVER_INDEX,
    AFFILIATE_FIRST_LOSS_COVER_INDEX,
    PERIOD_DURATION_MONTHLY,
    PERIOD_DURATION_QUARTERLY,
    PERIOD_DURATION_SEMI_ANNUALLY,
};

export async function deployProtocolContracts(
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress,
    poolOwner: SignerWithAddress,
): Promise<ProtocolContracts> {
    // Deploy EvaluationAgentNFT
    const eaNFTContract = await deploy("EvaluationAgentNFT", "EvaluationAgentNFT");

    // Deploy HumaConfig
    const humaConfigContract = await deploy("HumaConfig", "HumaConfig");

    await humaConfigContract.setHumaTreasury(treasury.getAddress());
    await humaConfigContract.setEANFTContractAddress(eaNFTContract.address);
    await humaConfigContract.setEAServiceAccount(eaServiceAccount.getAddress());
    await humaConfigContract.setPDSServiceAccount(pdsServiceAccount.getAddress());

    await humaConfigContract.addPauser(protocolOwner.getAddress());
    await humaConfigContract.addPauser(poolOwner.getAddress());

    await humaConfigContract.transferOwnership(protocolOwner.getAddress());
    if (await humaConfigContract.connect(protocolOwner).paused())
        await humaConfigContract.connect(protocolOwner).unpause();

    const mockTokenContract = await deploy("MockToken", "MockToken");

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
    const poolConfigContract = await deploy("PoolConfig", "PoolConfig");

    const poolFeeManagerContract = await deploy("PoolFeeManager", "PoolFeeManager");

    const poolSafeContract = await deploy("PoolSafe", "PoolSafe");

    const borrowerFirstLossCoverContract = await deploy(
        "FirstLossCover",
        "BorrowerFirstLossCover",
    );
    const affiliateFirstLossCoverContract = await deploy(
        "FirstLossCover",
        "AffiliateFirstLossCover",
    );

    const tranchesPolicyContract = await deploy(
        tranchesPolicyContractName,
        tranchesPolicyContractName,
    );

    const poolContract = await deploy("Pool", "Pool");

    const epochManagerContract = await deploy("EpochManager", "EpochManager");

    const seniorTrancheVaultContract = await deploy("TrancheVault", "SeniorTrancheVault");
    const juniorTrancheVaultContract = await deploy("TrancheVault", "JuniorTrancheVault");

    const calendarContract = await deploy("Calendar", "Calendar");

    const creditContract = await deploy(creditContractName, creditContractName);

    const creditDueManagerContract = await deploy("CreditDueManager", "CreditDueManager");

    const receivableContract = await deploy("Receivable", "Receivable");
    let tx = await receivableContract.initialize();
    await await tx.wait();
    console.log("Receivable initialized");

    tx = await receivableContract.grantRole(
        receivableContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.getAddress(),
    );
    await tx.wait();
    console.log("Receivable admin granted");

    tx = await receivableContract.renounceRole(
        receivableContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );
    await tx.wait();
    console.log("Receivable admin renounced");

    tx = await poolConfigContract.initialize("Test Pool", [
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
    ]);
    await tx.wait();
    console.log("PoolConfig initialized");
    tx = await poolConfigContract.setFirstLossCover(
        BORROWER_FIRST_LOSS_COVER_INDEX,
        borrowerFirstLossCoverContract.address,
        {
            coverRateInBps: 0,
            coverCap: 0,
            liquidityCap: 0,
            maxPercentOfPoolValueInBps: 0,
            riskYieldMultiplier: 0,
        },
    );
    await tx.wait();
    console.log("PoolConfig set borrower first loss cover");
    tx = await poolConfigContract.setFirstLossCover(
        AFFILIATE_FIRST_LOSS_COVER_INDEX,
        affiliateFirstLossCoverContract.address,
        {
            coverRateInBps: 0,
            coverCap: 0,
            liquidityCap: 0,
            maxPercentOfPoolValueInBps: 0,
            riskYieldMultiplier: 20000,
        },
    );
    await tx.wait();
    console.log("PoolConfig set affiliate first loss cover");

    tx = await poolConfigContract.grantRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.getAddress(),
    );
    await tx.wait();
    console.log("PoolConfig admin granted");

    tx = await poolConfigContract.renounceRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );
    await tx.wait();
    console.log("PoolConfig admin renounced");

    tx = await poolFeeManagerContract.initialize(poolConfigContract.address);
    await tx.wait();
    console.log("PoolFeeManager initialized");

    tx = await poolSafeContract.initialize(poolConfigContract.address);
    await tx.wait();
    console.log("PoolSafe initialized");

    tx = await borrowerFirstLossCoverContract["initialize(string,string,address)"](
        "Borrower First Loss Cover",
        "BFLC",
        poolConfigContract.address,
    );
    await tx.wait();
    console.log("BorrowerFirstLossCover initialized");

    tx = await affiliateFirstLossCoverContract["initialize(string,string,address)"](
        "Affiliate First Loss Cover",
        "AFLC",
        poolConfigContract.address,
    );
    await tx.wait();
    console.log("AffiliateFirstLossCover initialized");

    tx = await tranchesPolicyContract.initialize(poolConfigContract.address);
    await tx.wait();
    console.log("TranchesPolicy initialized");

    tx = await poolContract.initialize(poolConfigContract.address);
    await tx.wait();
    console.log("Pool initialized");

    tx = await epochManagerContract.initialize(poolConfigContract.address);
    await tx.wait();
    console.log("EpochManager initialized");

    tx = await seniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Senior Tranche Vault",
        "STV",
        poolConfigContract.address,
        SENIOR_TRANCHE,
    );
    await tx.wait();
    console.log("SeniorTrancheVault initialized");

    tx = await juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Junior Tranche Vault",
        "JTV",
        poolConfigContract.address,
        JUNIOR_TRANCHE,
    );
    await tx.wait();
    console.log("JuniorTrancheVault initialized");

    tx = await creditContract.connect(poolOwner).initialize(poolConfigContract.address);
    await tx.wait();
    console.log("Credit initialized");

    tx = await creditDueManagerContract.initialize(poolConfigContract.address);
    await tx.wait();
    console.log("CreditDueManager initialized");

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
    poolOwner: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
): Promise<void> {
    const poolLiquidityCap = toToken(1_000_000_000);

    let tx = await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(poolLiquidityCap);
    await tx.wait();
    console.log("PoolConfig set pool liquidity cap");

    tx = await poolConfigContract.connect(poolOwner).setMaxCreditLine(toToken(10_000_000));
    await tx.wait();
    console.log("PoolConfig set max credit line");

    tx = await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());
    await tx.wait();
    console.log("PoolConfig set pool owner treasury");

    let eaNFTTokenId;
    tx = await eaNFTContract.mintNFT(evaluationAgent.address);
    const receipt = await tx.wait();
    for (const evt of receipt.events!) {
        if (evt.event === "NFTGenerated") {
            eaNFTTokenId = evt.args!.tokenId;
        }
    }
    console.log("EvaluationAgentNFT minted");

    tx = await poolConfigContract
        .connect(poolOwner)
        .setEvaluationAgent(eaNFTTokenId, evaluationAgent.getAddress());
    await tx.wait();
    console.log("PoolConfig set evaluation agent");

    // Deposit enough liquidity for the pool owner and EA in the junior tranche.
    const adminRnR = await poolConfigContract.getAdminRnR();

    tx = await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await tx.wait();
    console.log("MockToken poolOwnerTreasury approved");

    tx = await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(1_000_000_000));
    await tx.wait();
    console.log("MockToken poolOwnerTreasury minted");

    const poolOwnerLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
        .mul(poolLiquidityCap)
        .div(CONSTANTS.BP_FACTOR);
    tx = await juniorTrancheVaultContract
        .connect(poolOwnerTreasury)
        .makeInitialDeposit(poolOwnerLiquidity);
    await tx.wait();
    console.log("JuniorTrancheVault poolOwnerTreasury initial deposit made");

    tx = await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await tx.wait();
    console.log("MockToken evaluationAgent approved");

    tx = await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(1_000_000_000));
    await tx.wait();
    console.log("MockToken evaluationAgent minted");

    const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
        .mul(poolLiquidityCap)
        .div(CONSTANTS.BP_FACTOR);
    tx = await juniorTrancheVaultContract
        .connect(evaluationAgent)
        .makeInitialDeposit(evaluationAgentLiquidity);
    await tx.wait();
    console.log("JuniorTrancheVault evaluationAgent initial deposit made");

    tx = await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await tx.wait();
    console.log("MockToken poolOwnerTreasury approved");

    tx = await mockTokenContract
        .connect(evaluationAgent)
        .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await tx.wait();
    console.log("MockToken evaluationAgent approved");
    const firstLossCoverageInBps = 100;

    tx = await affiliateFirstLossCoverContract
        .connect(poolOwner)
        .setCoverProvider(poolOwnerTreasury.getAddress(), {
            poolCapCoverageInBps: firstLossCoverageInBps,
            poolValueCoverageInBps: firstLossCoverageInBps,
        });
    await tx.wait();
    console.log("AffiliateFirstLossCover poolOwnerTreasury set cover provider");

    tx = await affiliateFirstLossCoverContract
        .connect(poolOwner)
        .setCoverProvider(evaluationAgent.getAddress(), {
            poolCapCoverageInBps: firstLossCoverageInBps,
            poolValueCoverageInBps: firstLossCoverageInBps,
        });
    await tx.wait();
    console.log("AffiliateFirstLossCover evaluationAgent set cover provider");

    const role = await poolConfigContract.POOL_OPERATOR_ROLE();

    tx = await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    await tx.wait();
    console.log("PoolConfig pool owner granted role");

    tx = await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());
    await tx.wait();
    console.log("PoolConfig pool operator granted role");

    tx = await juniorTrancheVaultContract
        .connect(poolOperator)
        .setReinvestYield(poolOwnerTreasury.address, true);
    await tx.wait();
    console.log("JuniorTrancheVault poolOwnerTreasury reinvest yield");

    tx = await juniorTrancheVaultContract
        .connect(poolOperator)
        .setReinvestYield(evaluationAgent.address, true);
    await tx.wait();
    console.log("JuniorTrancheVault evaluationAgent reinvest yield");

    tx = await affiliateFirstLossCoverContract
        .connect(poolOwnerTreasury)
        .depositCover(poolLiquidityCap.mul(firstLossCoverageInBps).div(CONSTANTS.BP_FACTOR));
    await tx.wait();
    console.log("AffiliateFirstLossCover poolOwnerTreasury deposited cover");

    tx = await affiliateFirstLossCoverContract
        .connect(evaluationAgent)
        .depositCover(poolLiquidityCap.mul(firstLossCoverageInBps).div(CONSTANTS.BP_FACTOR));
    await tx.wait();
    console.log("AffiliateFirstLossCover evaluationAgent deposited cover");

    tx = await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true);
    await tx.wait();
    console.log("Pool ready for first loss cover withdrawal");

    tx = await poolContract.connect(poolOwner).enablePool();
    await tx.wait();
    console.log("Pool enabled");

    for (let i = 0; i < accounts.length; i++) {
        console.log("********************");
        console.log("Add approved lender and approve mock token: ", accounts[i].address);
        tx = await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress(), true);
        await tx.wait();
        console.log("Add approved lender and approve mock token juniorTrancheVaultContract");
        tx = await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress(), true);
        await tx.wait();
        console.log("Add approved lender and approve mock token seniorTrancheVaultContract");
        tx = await mockTokenContract
            .connect(accounts[i])
            .approve(poolSafeContract.address, ethers.constants.MaxUint256);
        await tx.wait();
        console.log("MockToken approved poolSafeContract");
        tx = await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        await tx.wait();
        console.log("MockToken approved creditContract");
        tx = await mockTokenContract.mint(accounts[i].getAddress(), toToken(1_000_000_000));
        await tx.wait();
        console.log("MockToken minted");
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
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditDueManagerContract,
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
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditDueManagerContract,
        receivableContract,
    ];
}

export async function deployContracts() {
    const [
        defaultDeployer,
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
        poolOwnerTreasury,
        evaluationAgent,
        poolOperator,
        seniorLender,
        juniorLender,
    ] = await ethers.getSigners();

    const [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
    );

    await deployAndSetupPoolContracts(
        humaConfigContract,
        mockTokenContract,
        eaNFTContract,
        "FixedSeniorYieldTranchePolicy",
        defaultDeployer,
        poolOwner,
        "MockPoolCredit",
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        [seniorLender, juniorLender],
    );
}

deployContracts();
