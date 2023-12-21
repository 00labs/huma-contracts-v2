import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    CONSTANTS,
    CreditContractName,
    CreditManagerContractName,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    PayPeriodDuration,
} from "../test/BaseTest";
import {
    getMinFirstLossCoverRequirement,
    overrideFirstLossCoverConfig,
    toToken,
} from "../test/TestUtils";
import {
    BorrowerLevelCreditManager,
    Calendar,
    CreditDueManager,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let juniorLender: SignerWithAddress,
    seniorLender: SignerWithAddress,
    poolAffiliate: SignerWithAddress,
    lenderRedemptionActive: SignerWithAddress,
    borrowerActive: SignerWithAddress,
    borrowerApproved: SignerWithAddress,
    borrowerNoAutopay: SignerWithAddress,
    borrowerAutopayReady: SignerWithAddress,
    borrowerLate: SignerWithAddress,
    borrowerDefault: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: BorrowerLevelCreditManager;

async function depositFirstLossCover(
    poolContract: Pool,
    coverContract: FirstLossCover,
    account: SignerWithAddress,
) {
    const fetchPoolConfigContractAddr = await poolContract.poolConfig();
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const fetchPoolConfigContract = PoolConfig.attach(fetchPoolConfigContractAddr);

    await coverContract.connect(poolOwner).setCoverProvider(account.address, {
        poolCapCoverageInBps: 1,
        poolValueCoverageInBps: 100,
    });
    await mockTokenContract
        .connect(account)
        .approve(coverContract.address, ethers.constants.MaxUint256);
    await coverContract
        .connect(account)
        .depositCover(
            (
                await getMinFirstLossCoverRequirement(
                    coverContract,
                    fetchPoolConfigContract,
                    poolContract,
                    account.address,
                )
            ).mul(2),
        );
}

async function deployPool(
    creditContractName: CreditContractName,
    creditManagerContractName: CreditManagerContractName,
    poolName?: "ArfV2",
) {
    console.log("=====================================");
    console.log(`Deploying pool with ${creditContractName} and ${creditManagerContractName}`);
    if (poolName) {
        console.log(`Pool name: ${poolName}`);
    }
    console.log(`Starting block timestamp: ${await time.latest()}`);
    [
        defaultDeployer,
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
        poolOwnerTreasury,
        evaluationAgent,
        poolOperator,
        juniorLender,
        seniorLender,
        poolAffiliate,
        lenderRedemptionActive,
        borrowerActive,
        borrowerApproved,
        borrowerNoAutopay,
        borrowerAutopayReady,
        borrowerLate,
        borrowerDefault,
    ] = await ethers.getSigners();

    console.log("Deploying and setting up protocol contracts");
    [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
    );

    [
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
        creditContract as unknown,
        creditDueManagerContract,
        creditManagerContract as unknown,
    ] = await deployAndSetupPoolContracts(
        humaConfigContract,
        mockTokenContract,
        eaNFTContract,
        "RiskAdjustedTranchesPolicy",
        defaultDeployer,
        poolOwner,
        creditContractName,
        creditManagerContractName,
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        [juniorLender, seniorLender, poolAffiliate, lenderRedemptionActive, borrowerActive],
    );

    // Deposit first loss cover
    await depositFirstLossCover(poolContract, borrowerFirstLossCoverContract, borrowerActive);

    // Set first loss cover liquidity cap
    const totalAssetsBorrowerFLC = await borrowerFirstLossCoverContract.totalAssets();
    const totalAssetsAffiliateFLC = await affiliateFirstLossCoverContract.totalAssets();
    const yieldAmount = toToken(10_000);
    await overrideFirstLossCoverConfig(
        borrowerFirstLossCoverContract,
        CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX,
        poolConfigContract,
        poolOwner,
        {
            liquidityCap: totalAssetsBorrowerFLC.sub(yieldAmount),
        },
    );
    await overrideFirstLossCoverConfig(
        affiliateFirstLossCoverContract,
        CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
        poolConfigContract,
        poolOwner,
        {
            liquidityCap: totalAssetsAffiliateFLC.sub(yieldAmount),
        },
    );

    // Depositing junior and senior liquidity into the tranches
    await juniorTrancheVaultContract
        .connect(juniorLender)
        .deposit(toToken(150_000), juniorLender.address);
    await seniorTrancheVaultContract
        .connect(seniorLender)
        .deposit(toToken(200_000), seniorLender.address);

    const frontLoadingFeeFlat = toToken(100);
    const frontLoadingFeeBps = BN.from(100);
    await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
        frontLoadingFeeFlat: frontLoadingFeeFlat,
        frontLoadingFeeBps: frontLoadingFeeBps,
    });

    if (poolName === "ArfV2") {
        const lateGracePeriodInDays = 5;
        const advanceRate = CONSTANTS.BP_FACTOR;
        const yieldInBps = 1200;
        const lateFeeBps = 2400;
        const principalRate = 0;
        await poolConfigContract.connect(poolOwner).setPoolPayPeriod(PayPeriodDuration.Monthly);
        await poolConfigContract
            .connect(poolOwner)
            .setLatePaymentGracePeriodInDays(lateGracePeriodInDays);
        await poolConfigContract.connect(poolOwner).setAdvanceRateInBps(advanceRate);
        await poolConfigContract.connect(poolOwner).setReceivableAutoApproval(true);

        await poolConfigContract.connect(poolOwner).setFeeStructure({
            yieldInBps,
            minPrincipalRateInBps: principalRate,
            lateFeeBps,
        });
    }

    console.log("=====================================");
    console.log("Accounts:");
    console.log(`Junior lender: ${juniorLender.address}`);
    console.log(`Senior lender: ${seniorLender.address}`);
    console.log(`Borrower:      ${borrowerActive.address}`);
    console.log(`PDS service:   ${pdsServiceAccount.address}`);
    console.log(`Pool owner:   ${poolOwner.address}`);
    console.log(`EA service:   ${eaServiceAccount.address}`);

    console.log("=====================================");
    console.log("Addresses:");
    console.log(`Pool:            ${poolContract.address}`);
    console.log("     (note: pool is ready for junior redemption epoch processing)");
    console.log(`Epoch manager:   ${epochManagerContract.address}`);
    console.log(`Pool config:     ${poolConfigContract.address}`);
    console.log(`Pool credit:     ${creditContract.address}`);
    console.log(`Junior tranche:  ${juniorTrancheVaultContract.address}`);
    console.log(`Senior tranche:  ${seniorTrancheVaultContract.address}`);
    console.log(`Pool safe:       ${poolSafeContract.address}`);
    console.log(`Test token:      ${mockTokenContract.address}`);
    console.log(`Credit:          ${creditContract.address}`);
    console.log(`Credit manager:  ${creditManagerContract.address}`);
    console.log(`Borrower FLC:    ${borrowerFirstLossCoverContract.address}`);
    console.log(`Affiliate FLC:   ${affiliateFirstLossCoverContract.address}`);

    console.log("=====================================");
    console.log(`Current block timestamp: ${await time.latest()}`);
}

async function deployPools() {
    try {
        await deployPool("CreditLine", "BorrowerLevelCreditManager");
        await deployPool(
            "ReceivableBackedCreditLine",
            "ReceivableBackedCreditLineManager",
            "ArfV2",
        );
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

deployPools();
