import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import { toToken } from "../test/TestUtils";
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
import { awaitTx } from "./commonUtils";
import { deploy } from "./deployUtils";

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
    SECONDS_IN_A_YEAR,
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
    creditManagerContractName: CreditManagerContractName,
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

    const creditManagerContract = await deploy(
        creditManagerContractName,
        creditManagerContractName,
    );

    const receivableContract = await deploy("Receivable", "Receivable");

    awaitTx(await receivableContract.initialize(), "Receivable initialized");
    awaitTx(
        await receivableContract.grantRole(
            receivableContract.DEFAULT_ADMIN_ROLE(),
            poolOwner.getAddress(),
        ),
        "Receivable admin granted",
    );
    awaitTx(
        await receivableContract.renounceRole(
            receivableContract.DEFAULT_ADMIN_ROLE(),
            deployer.getAddress(),
        ),
        "Receivable admin renounced",
    );

    awaitTx(
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
        ]),
        "PoolConfig initialized",
    );
    awaitTx(
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
        ),
        "Borrower First Loss Cover set",
    );
    awaitTx(
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
        ),
        "Affiliate First Loss Cover set",
    );

    awaitTx(
        await poolConfigContract.grantRole(
            await poolConfigContract.DEFAULT_ADMIN_ROLE(),
            poolOwner.getAddress(),
        ),
        "PoolConfig admin granted",
    );
    awaitTx(
        await poolConfigContract.renounceRole(
            await poolConfigContract.DEFAULT_ADMIN_ROLE(),
            deployer.getAddress(),
        ),
        "PoolConfig admin renounced",
    );

    awaitTx(
        await poolFeeManagerContract.initialize(poolConfigContract.address),
        "PoolFeeManager initialized",
    );
    awaitTx(await poolSafeContract.initialize(poolConfigContract.address), "PoolSafe initialized");
    awaitTx(
        await borrowerFirstLossCoverContract["initialize(string,string,address)"](
            "Borrower First Loss Cover",
            "BFLC",
            poolConfigContract.address,
        ),
        "BorrowerFirstLossCover initialized",
    );
    awaitTx(
        await affiliateFirstLossCoverContract["initialize(string,string,address)"](
            "Affiliate First Loss Cover",
            "AFLC",
            poolConfigContract.address,
        ),
        "AffiliateFirstLossCover initialized",
    );
    awaitTx(
        await tranchesPolicyContract.initialize(poolConfigContract.address),
        "TranchesPolicy initialized",
    );
    awaitTx(await poolContract.initialize(poolConfigContract.address), "Pool initialized");
    awaitTx(
        await epochManagerContract.initialize(poolConfigContract.address),
        "EpochManager initialized",
    );
    awaitTx(
        await seniorTrancheVaultContract["initialize(string,string,address,uint8)"](
            "Senior Tranche Vault",
            "STV",
            poolConfigContract.address,
            SENIOR_TRANCHE,
        ),
        "SeniorTrancheVault initialized",
    );
    awaitTx(
        await juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
            "Junior Tranche Vault",
            "JTV",
            poolConfigContract.address,
            JUNIOR_TRANCHE,
        ),
        "JuniorTrancheVault initialized",
    );
    awaitTx(
        await creditContract.connect(poolOwner).initialize(poolConfigContract.address),
        "Credit initialized",
    );
    awaitTx(
        await creditDueManagerContract.initialize(poolConfigContract.address),
        "CreditDueManager initialized",
    );
    awaitTx(
        await creditManagerContract.initialize(poolConfigContract.address),
        "CreditManager initialized",
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
    awaitTx(
        await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(poolLiquidityCap),
        "Pool liquidity cap set",
    );
    awaitTx(
        await poolConfigContract.connect(poolOwner).setMaxCreditLine(toToken(10_000_000)),
        "Max credit line set",
    );

    awaitTx(
        await poolConfigContract
            .connect(poolOwner)
            .setPoolOwnerTreasury(poolOwnerTreasury.getAddress()),
        "Pool owner treasury set",
    );

    let eaNFTTokenId;
    const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
    const receipt = await tx.wait();
    for (const evt of receipt.events!) {
        if (evt.event === "NFTGenerated") {
            eaNFTTokenId = evt.args!.tokenId;
        }
    }
    console.log("EvaluationAgentNFT minted");
    awaitTx(
        await poolConfigContract
            .connect(poolOwner)
            .setEvaluationAgent(eaNFTTokenId, evaluationAgent.getAddress()),
        "EvaluationAgent set",
    );

    // Deposit enough liquidity for the pool owner and EA in the junior tranche.
    const adminRnR = await poolConfigContract.getAdminRnR();
    awaitTx(
        await mockTokenContract
            .connect(poolOwnerTreasury)
            .approve(poolSafeContract.address, ethers.constants.MaxUint256),
        "MockToken approved",
    );
    awaitTx(
        await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(1_000_000_000)),
        "MockToken minted",
    );
    const poolOwnerLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
        .mul(poolLiquidityCap)
        .div(CONSTANTS.BP_FACTOR);
    awaitTx(
        await juniorTrancheVaultContract
            .connect(poolOwnerTreasury)
            .makeInitialDeposit(poolOwnerLiquidity),
        "Pool owner liquidity deposited",
    );

    awaitTx(
        await mockTokenContract
            .connect(evaluationAgent)
            .approve(poolSafeContract.address, ethers.constants.MaxUint256),
        "MockToken approved",
    );
    awaitTx(
        await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(1_000_000_000)),
        "MockToken minted",
    );
    const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
        .mul(poolLiquidityCap)
        .div(CONSTANTS.BP_FACTOR);
    awaitTx(
        await juniorTrancheVaultContract
            .connect(evaluationAgent)
            .makeInitialDeposit(evaluationAgentLiquidity),
        "Evaluation agent liquidity deposited",
    );

    awaitTx(
        await mockTokenContract
            .connect(poolOwnerTreasury)
            .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256),
        "MockToken approved",
    );
    awaitTx(
        await mockTokenContract
            .connect(evaluationAgent)
            .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256),
        "MockToken approved",
    );
    const firstLossCoverageInBps = 100;
    awaitTx(
        await affiliateFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(poolOwnerTreasury.getAddress(), {
                poolCapCoverageInBps: firstLossCoverageInBps,
                poolValueCoverageInBps: firstLossCoverageInBps,
            }),
        "AffiliateFirstLossCover setCoverProvider",
    );
    awaitTx(
        await affiliateFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(evaluationAgent.getAddress(), {
                poolCapCoverageInBps: firstLossCoverageInBps,
                poolValueCoverageInBps: firstLossCoverageInBps,
            }),
        "AffiliateFirstLossCover setCoverProvider",
    );

    const role = await poolConfigContract.POOL_OPERATOR_ROLE();
    awaitTx(
        await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress()),
        "poolOwner granted role",
    );
    awaitTx(
        await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress()),
        "poolOperator granted role",
    );

    awaitTx(
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .setReinvestYield(poolOwnerTreasury.address, true),
        "Reinvest yield set",
    );
    awaitTx(
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .setReinvestYield(evaluationAgent.address, true),
        "Reinvest yield set",
    );

    awaitTx(
        await affiliateFirstLossCoverContract
            .connect(poolOwnerTreasury)
            .depositCover(poolLiquidityCap.mul(firstLossCoverageInBps).div(CONSTANTS.BP_FACTOR)),
        "AffiliateFirstLossCover depositCover",
    );
    awaitTx(
        await affiliateFirstLossCoverContract
            .connect(evaluationAgent)
            .depositCover(poolLiquidityCap.mul(firstLossCoverageInBps).div(CONSTANTS.BP_FACTOR)),
        "AffiliateFirstLossCover depositCover",
    );
    awaitTx(
        await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true),
        "poolOwner setReadyForFirstLossCoverWithdrawal",
    );

    const lpConfig = await poolConfigContract.getLPConfig();
    const newLPConfig = {
        ...lpConfig,
        fixedSeniorYieldInBps: 1217,
    };
    awaitTx(
        await poolConfigContract.connect(poolOwner).setLPConfig(newLPConfig),
        "poolOwner setLPConfig",
    );

    awaitTx(await poolContract.connect(poolOwner).enablePool(), "Pool enabled");

    for (let i = 0; i < accounts.length; i++) {
        console.log("********************");
        console.log("Add approved lender and approve mock token: ", accounts[i].address);
        awaitTx(
            await juniorTrancheVaultContract
                .connect(poolOperator)
                .addApprovedLender(accounts[i].getAddress(), true),
            "Approved lender added",
        );
        awaitTx(
            await seniorTrancheVaultContract
                .connect(poolOperator)
                .addApprovedLender(accounts[i].getAddress(), true),
            "Approved lender added",
        );
        awaitTx(
            await mockTokenContract
                .connect(accounts[i])
                .approve(poolSafeContract.address, ethers.constants.MaxUint256),
            "MockToken approved",
        );
        awaitTx(
            await mockTokenContract
                .connect(accounts[i])
                .approve(creditContract.address, ethers.constants.MaxUint256),
            "MockToken approved",
        );
        awaitTx(
            await mockTokenContract.mint(accounts[i].getAddress(), toToken(1_000_000_000)),
            "MockToken minted",
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
        "CreditLine",
        "BorrowerLevelCreditManager",
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        [seniorLender, juniorLender],
    );
}

deployContracts();
