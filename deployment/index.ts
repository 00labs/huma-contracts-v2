import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";

import { CONSTANTS } from "../test/constants";
import { getMinLiquidityRequirementForPoolOwner, toToken } from "../test/TestUtils";
import {
    BaseTranchesPolicy,
    Calendar,
    CreditDueManager,
    CreditLine,
    CreditLineManager,
    EpochManager,
    FirstLossCover,
    FixedSeniorYieldTranchePolicy,
    HumaConfig,
    MockPoolCredit,
    MockPoolCreditManager,
    MockToken,
    MockTokenNonStandardERC20,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    ReceivableBackedCreditLine,
    ReceivableBackedCreditLineManager,
    ReceivableFactoringCredit,
    ReceivableFactoringCreditManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import { awaitTx } from "./commonUtils";
import { deploy, deployProxy } from "./deployUtils";

export type CreditContractType =
    | MockPoolCredit
    | CreditLine
    | ReceivableBackedCreditLine
    | ReceivableFactoringCredit;
export type CreditManagerContractType =
    | MockPoolCreditManager
    | CreditLineManager
    | ReceivableBackedCreditLineManager
    | ReceivableFactoringCreditManager;
export type ProtocolContracts = [HumaConfig, MockToken];
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
export type PoolImplementations = [
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    FirstLossCover,
    RiskAdjustedTranchesPolicy,
    FixedSeniorYieldTranchePolicy,
    Pool,
    EpochManager,
    TrancheVault,
    CreditLine,
    ReceivableBackedCreditLine,
    ReceivableFactoringCredit,
    CreditDueManager,
    CreditLineManager,
    ReceivableBackedCreditLineManager,
    ReceivableFactoringCreditManager,
    Receivable,
];

export type PoolRecord = {
    poolId: BN;
    poolAddress: string;
    poolName: string;
    poolStatus: PoolStatus;
    poolConfigAddress: string;
    poolTimelock: string;
};

type CreditType = "creditline" | "receivablebcked" | "receivablefactoring";
type TranchesPolicyType = "fixed" | "adjusted";
export type TranchesPolicyContractName =
    | "FixedSeniorYieldTranchePolicy"
    | "RiskAdjustedTranchesPolicy";
export type CreditContractName =
    | "CreditLine"
    | "ReceivableBackedCreditLine"
    | "ReceivableFactoringCredit"
    | "MockPoolCredit";
export type CreditManagerContractName =
    | "CreditLineManager"
    | "ReceivableBackedCreditLineManager"
    | "ReceivableFactoringCreditManager"
    | "MockPoolCreditManager";

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

export enum PoolStatus {
    Created,
    Initialized,
    Closed,
}

export async function deployProtocolContracts(
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress,
    poolOwner: SignerWithAddress,
): Promise<ProtocolContracts> {
    // Deploy HumaConfig
    const humaConfigContract = await deploy("HumaConfig", "HumaConfig");

    await humaConfigContract.setHumaTreasury(treasury.getAddress());
    await humaConfigContract.setSentinelServiceAccount(sentinelServiceAccount.getAddress());

    await humaConfigContract.addPauser(protocolOwner.getAddress());
    await humaConfigContract.addPauser(poolOwner.getAddress());

    await humaConfigContract.transferOwnership(protocolOwner.getAddress());
    if (await humaConfigContract.connect(protocolOwner).paused())
        await humaConfigContract.connect(protocolOwner).unpause();

    const mockTokenContract = await deploy("MockToken", "MockToken");

    await humaConfigContract
        .connect(protocolOwner)
        .setLiquidityAsset(mockTokenContract.address, true);

    return [humaConfigContract, mockTokenContract];
}

export async function deployPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken | MockTokenNonStandardERC20,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: SignerWithAddress,
    poolOwner: SignerWithAddress,
    creditContractName: CreditContractName,
    creditManagerContractName: CreditManagerContractName,
): Promise<PoolContracts> {
    const poolConfigContract = await deployProxy("PoolConfig", "PoolConfig");

    const poolFeeManagerContract = await deployProxy("PoolFeeManager", "PoolFeeManager");

    const poolSafeContract = await deployProxy("PoolSafe", "PoolSafe");

    const borrowerFirstLossCoverContract = await deployProxy(
        "FirstLossCover",
        "BorrowerFirstLossCover",
    );
    const adminFirstLossCoverContract = await deployProxy("FirstLossCover", "AdminFirstLossCover");

    const tranchesPolicyContract = await deployProxy(
        tranchesPolicyContractName,
        tranchesPolicyContractName,
    );

    const poolContract = await deployProxy("Pool", "Pool");

    const epochManagerContract = await deployProxy("EpochManager", "EpochManager");

    const seniorTrancheVaultContract = await deployProxy("TrancheVault", "SeniorTrancheVault");
    const juniorTrancheVaultContract = await deployProxy("TrancheVault", "JuniorTrancheVault");

    const calendarContract = await deploy("Calendar", "Calendar");

    const creditContract = await deployProxy(creditContractName, creditContractName);

    const creditManagerContract = await deployProxy(
        creditManagerContractName,
        creditManagerContractName,
    );

    const creditDueManagerContract = await deployProxy("CreditDueManager", "CreditDueManager");

    const receivableContract = await deployProxy("Receivable", "Receivable", "initialize");

    await awaitTx(
        await receivableContract.grantRole(
            receivableContract.DEFAULT_ADMIN_ROLE(),
            poolOwner.getAddress(),
        ),
        "Receivable admin granted",
    );
    await awaitTx(
        await receivableContract.renounceRole(
            receivableContract.DEFAULT_ADMIN_ROLE(),
            deployer.getAddress(),
        ),
        "Receivable admin renounced",
    );

    await awaitTx(
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
    await awaitTx(
        await poolConfigContract.setFirstLossCover(
            CONSTANTS.BORROWER_LOSS_COVER_INDEX,
            borrowerFirstLossCoverContract.address,
            {
                coverRatePerLossInBps: 0,
                coverCapPerLoss: 0,
                maxLiquidity: toToken(100_000_000),
                minLiquidity: 0,
                riskYieldMultiplierInBps: 0,
            },
        ),
        "Borrower First Loss Cover set",
    );
    await awaitTx(
        await poolConfigContract.setReceivableAsset(receivableContract.address),
        "Receivable asset set",
    );
    await awaitTx(
        await poolConfigContract.setFirstLossCover(
            CONSTANTS.ADMIN_LOSS_COVER_INDEX,
            adminFirstLossCoverContract.address,
            {
                coverRatePerLossInBps: 0,
                coverCapPerLoss: 0,
                maxLiquidity: toToken(100_000_000),
                minLiquidity: 0,
                riskYieldMultiplierInBps: 20000,
            },
        ),
        "Affiliate First Loss Cover set",
    );

    await awaitTx(
        await poolConfigContract.grantRole(
            await poolConfigContract.DEFAULT_ADMIN_ROLE(),
            poolOwner.getAddress(),
        ),
        "PoolConfig admin granted",
    );
    await awaitTx(
        await poolConfigContract.renounceRole(
            await poolConfigContract.DEFAULT_ADMIN_ROLE(),
            deployer.getAddress(),
        ),
        "PoolConfig admin renounced",
    );

    await awaitTx(
        await poolFeeManagerContract.initialize(poolConfigContract.address),
        "PoolFeeManager initialized",
    );
    await awaitTx(
        await poolSafeContract.initialize(poolConfigContract.address),
        "PoolSafe initialized",
    );
    await awaitTx(
        await borrowerFirstLossCoverContract["initialize(string,string,address)"](
            "Borrower First Loss Cover",
            "BFLC",
            poolConfigContract.address,
        ),
        "BorrowerFirstLossCover initialized",
    );
    await awaitTx(
        await adminFirstLossCoverContract["initialize(string,string,address)"](
            "Admin First Loss Cover",
            "AFLC",
            poolConfigContract.address,
        ),
        "AdminFirstLossCover initialized",
    );
    await awaitTx(
        await tranchesPolicyContract.initialize(poolConfigContract.address),
        "TranchesPolicy initialized",
    );
    await awaitTx(await poolContract.initialize(poolConfigContract.address), "Pool initialized");
    await awaitTx(
        await epochManagerContract.initialize(poolConfigContract.address),
        "EpochManager initialized",
    );
    await awaitTx(
        await seniorTrancheVaultContract["initialize(string,string,address,uint8)"](
            "Senior Tranche Vault",
            "STV",
            poolConfigContract.address,
            CONSTANTS.SENIOR_TRANCHE,
        ),
        "SeniorTrancheVault initialized",
    );
    await awaitTx(
        await juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
            "Junior Tranche Vault",
            "JTV",
            poolConfigContract.address,
            CONSTANTS.JUNIOR_TRANCHE,
        ),
        "JuniorTrancheVault initialized",
    );
    await awaitTx(
        await creditContract.connect(poolOwner).initialize(poolConfigContract.address),
        "Credit initialized",
    );
    await awaitTx(
        await creditDueManagerContract.initialize(poolConfigContract.address),
        "CreditDueManager initialized",
    );
    await awaitTx(
        await creditManagerContract.initialize(poolConfigContract.address),
        "CreditManager initialized",
    );

    return [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        adminFirstLossCoverContract,
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
    mockTokenContract: MockToken | MockTokenNonStandardERC20,
    borrowerFirstLossCoverContract: FirstLossCover,
    adminFirstLossCoverContract: FirstLossCover,
    poolSafeContract: PoolSafe,
    poolContract: Pool,
    juniorTrancheVaultContract: TrancheVault,
    seniorTrancheVaultContract: TrancheVault,
    creditContract: CreditContractType,
    receivableContract: Receivable,
    poolOwner: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    humaTreasury: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
    shouldSetEA: boolean = true,
    creditContractName: CreditContractName,
): Promise<void> {
    const poolLiquidityCap = toToken(1_000_000_000);
    const settings = await poolConfigContract.getPoolSettings();
    await awaitTx(
        await poolConfigContract
            .connect(poolOwner)
            .setPoolSettings({ ...settings, ...{ maxCreditLine: toToken(10_000_000) } }),
        "Max credit line set",
    );
    const lpConfig = await poolConfigContract.getLPConfig();
    await awaitTx(
        await poolConfigContract
            .connect(poolOwner)
            .setLPConfig({ ...lpConfig, ...{ liquidityCap: poolLiquidityCap } }),
        "Pool liquidity cap set",
    );

    await awaitTx(
        await poolConfigContract
            .connect(poolOwner)
            .setPoolOwnerTreasury(poolOwnerTreasury.getAddress()),
        "Pool owner treasury set",
    );

    let role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await awaitTx(
        await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress()),
        "poolOwner granted role",
    );
    await awaitTx(
        await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress()),
        "poolOperator granted role",
    );

    // Deposit enough liquidity for the pool owner in both tranches.
    const adminRnR = await poolConfigContract.getAdminRnR();
    await awaitTx(
        await mockTokenContract
            .connect(poolOwnerTreasury)
            .approve(poolSafeContract.address, ethers.constants.MaxUint256),
        "MockToken approved",
    );
    await awaitTx(
        await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(1_000_000_000)),
        "MockToken minted",
    );
    const poolOwnerLiquidity = await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
    await awaitTx(
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(poolOwnerTreasury.getAddress(), true),
        "Approved lender added to juniorTrancheVault for pool owner treasury",
    );
    await awaitTx(
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(poolOwnerTreasury.getAddress(), true),
        "Approved lender added to seniorTrancheVault for pool owner treasury",
    );
    await awaitTx(
        await juniorTrancheVaultContract
            .connect(poolOwnerTreasury)
            .makeInitialDeposit(poolOwnerLiquidity),
        "Pool owner liquidity deposited",
    );

    const poolSettings = await poolConfigContract.getPoolSettings();

    await awaitTx(
        await seniorTrancheVaultContract
            .connect(poolOwnerTreasury)
            .makeInitialDeposit(poolSettings.minDepositAmount),
        "Pool owner treasury initial deposit",
    );

    await awaitTx(
        await mockTokenContract
            .connect(evaluationAgent)
            .approve(poolSafeContract.address, ethers.constants.MaxUint256),
        "MockToken approved",
    );
    await awaitTx(
        await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(1_000_000_000)),
        "MockToken minted",
    );
    if (shouldSetEA) {
        await awaitTx(
            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(evaluationAgent.getAddress()),
            "EvaluationAgent set",
        );
        const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByEA)
            .mul(poolLiquidityCap)
            .div(CONSTANTS.BP_FACTOR);
        await awaitTx(
            await juniorTrancheVaultContract
                .connect(evaluationAgent)
                .makeInitialDeposit(evaluationAgentLiquidity),
            "Evaluation agent liquidity deposited",
        );
    }

    await awaitTx(
        await mockTokenContract
            .connect(poolOwnerTreasury)
            .approve(adminFirstLossCoverContract.address, ethers.constants.MaxUint256),
        "MockToken approved",
    );
    await awaitTx(
        await mockTokenContract
            .connect(evaluationAgent)
            .approve(adminFirstLossCoverContract.address, ethers.constants.MaxUint256),
        "MockToken approved",
    );
    await awaitTx(
        await adminFirstLossCoverContract
            .connect(poolOwner)
            .addCoverProvider(poolOwnerTreasury.getAddress()),
        "AffiliateFirstLossCover setCoverProvider",
    );
    await awaitTx(
        await adminFirstLossCoverContract
            .connect(poolOwner)
            .addCoverProvider(evaluationAgent.getAddress()),
        "AffiliateFirstLossCover setCoverProvider",
    );

    role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await awaitTx(
        await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress()),
        "poolOwner granted role",
    );
    await awaitTx(
        await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress()),
        "poolOperator granted role",
    );

    await awaitTx(
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .setReinvestYield(poolOwnerTreasury.address, true),
        "Reinvest yield set",
    );
    await awaitTx(
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .setReinvestYield(evaluationAgent.address, true),
        "Reinvest yield set",
    );

    await awaitTx(
        await adminFirstLossCoverContract.connect(poolOwnerTreasury).depositCover(toToken(10_000)),
        "AffiliateFirstLossCover depositCover",
    );
    await awaitTx(
        await adminFirstLossCoverContract.connect(evaluationAgent).depositCover(toToken(10_000)),
        "AffiliateFirstLossCover depositCover",
    );
    await awaitTx(
        await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true),
        "poolOwner setReadyForFirstLossCoverWithdrawal",
    );

    if (creditContractName === "ReceivableBackedCreditLine") {
        const latePaymentGracePeriodInDays = 5;
        const yieldInBps = 1217;
        const lateFeeBps = 2400;
        const principalRate = 100;

        const settings = await poolConfigContract.getPoolSettings();
        await awaitTx(
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    payPeriodDuration: PayPeriodDuration.Monthly,
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                    receivableAutoApproval: true,
                },
            }),
            "Pool settings set",
        );

        await awaitTx(
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            }),
            "Pool fee structure set",
        );
    }

    await awaitTx(await poolContract.connect(poolOwner).enablePool(), "Pool enabled");

    for (let i = 0; i < accounts.length; i++) {
        console.log("********************");
        console.log("Add approved lender and approve mock token: ", accounts[i].address);
        await awaitTx(
            await juniorTrancheVaultContract
                .connect(poolOperator)
                .addApprovedLender(accounts[i].getAddress(), true),
            "Approved lender added",
        );
        await awaitTx(
            await seniorTrancheVaultContract
                .connect(poolOperator)
                .addApprovedLender(accounts[i].getAddress(), true),
            "Approved lender added",
        );
        await awaitTx(
            await mockTokenContract
                .connect(accounts[i])
                .approve(poolSafeContract.address, ethers.constants.MaxUint256),
            "MockToken approved",
        );
        await awaitTx(
            await mockTokenContract
                .connect(accounts[i])
                .approve(creditContract.address, ethers.constants.MaxUint256),
            "MockToken approved",
        );
        await awaitTx(
            await mockTokenContract.mint(accounts[i].getAddress(), toToken(1_000_000_000)),
            "MockToken minted",
        );
        await awaitTx(
            await receivableContract
                .connect(poolOwner)
                .grantRole(await receivableContract.MINTER_ROLE(), accounts[i].getAddress()),
            "Receivable grant pool owner mint role",
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
        adminFirstLossCoverContract,
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
        adminFirstLossCoverContract,
        poolSafeContract,
        poolContract,
        juniorTrancheVaultContract,
        seniorTrancheVaultContract,
        creditContract,
        receivableContract,
        poolOwner,
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        accounts,
        shouldSetEA,
        creditContractName,
    );

    return [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        adminFirstLossCoverContract,
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

export async function deployContracts(
    creditContractName: CreditContractName,
    creditManagerContractName: CreditManagerContractName,
) {
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
        creditContractName,
        creditManagerContractName,
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        [seniorLender, juniorLender],
    );
}

// deployContracts("CreditLine", "CreditLineManager");
deployContracts("ReceivableBackedCreditLine", "ReceivableBackedCreditLineManager");
