import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    CreditContractName,
    CreditManagerContractName,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    PayPeriodDuration,
} from "../test/BaseTest";
import { CONSTANTS } from "../test/constants";
import { overrideFirstLossCoverConfig, toToken } from "../test/TestUtils";
import {
    Calendar,
    CreditDueManager,
    CreditLine,
    CreditLineManager,
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
    sentinelServiceAccount: SignerWithAddress;
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
    creditManagerContract: CreditLineManager;

async function depositFirstLossCover(coverContract: FirstLossCover, account: SignerWithAddress) {
    await coverContract.connect(poolOwner).addCoverProvider(account.address);
    await mockTokenContract
        .connect(account)
        .approve(coverContract.address, ethers.constants.MaxUint256);
    await coverContract.connect(account).depositCover(toToken(20_000));
}

export enum PoolName {
    CreditLine = "CreditLine",
    ArfV2 = "ArfV2",
}

async function deployPool(
    creditContractName: CreditContractName,
    creditManagerContractName: CreditManagerContractName,
    poolName?: PoolName,
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
        sentinelServiceAccount,
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
        sentinelServiceAccount,
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
    await depositFirstLossCover(borrowerFirstLossCoverContract, borrowerActive);

    // Set first loss cover liquidity cap
    const totalAssetsBorrowerFLC = await borrowerFirstLossCoverContract.totalAssets();
    const totalAssetsAffiliateFLC = await affiliateFirstLossCoverContract.totalAssets();
    const yieldAmount = toToken(10_000);
    await overrideFirstLossCoverConfig(
        borrowerFirstLossCoverContract,
        CONSTANTS.BORROWER_LOSS_COVER_INDEX,
        poolConfigContract,
        poolOwner,
        {
            maxLiquidity: totalAssetsBorrowerFLC.add(yieldAmount),
        },
    );
    await overrideFirstLossCoverConfig(
        affiliateFirstLossCoverContract,
        CONSTANTS.ADMIN_LOSS_COVER_INDEX,
        poolConfigContract,
        poolOwner,
        {
            maxLiquidity: totalAssetsAffiliateFLC.add(yieldAmount),
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

    if (poolName === PoolName.CreditLine) {
        console.log("Drawing down from CreditLine");
        await creditManagerContract.connect(eaServiceAccount).approveBorrower(
            borrowerActive.address,
            toToken(100_000),
            5, // numOfPeriods
            1217, // yieldInBps
            toToken(0),
            0,
            true,
        );
        const borrowAmount = toToken(100_000);

        // Drawing down credit line
        await creditContract
            .connect(borrowerActive)
            .drawdown(borrowerActive.address, borrowAmount);
    } else if (poolName === PoolName.ArfV2) {
        const latePaymentGracePeriodInDays = 5;
        const yieldInBps = 1200;
        const lateFeeBps = 2400;
        const principalRate = 0;

        const settings = await poolConfigContract.getPoolSettings();
        await poolConfigContract.connect(poolOwner).setPoolSettings({
            ...settings,
            ...{
                payPeriodDuration: PayPeriodDuration.Monthly,
                latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                advanceRateInBps: CONSTANTS.BP_FACTOR,
                receivableAutoApproval: true,
            },
        });

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
    console.log(`Sentinel Service:   ${sentinelServiceAccount.address}`);
    console.log(`Pool owner:   ${poolOwner.address}`);
    console.log(`EA service:   ${eaServiceAccount.address}`);

    console.log("=====================================");
    console.log("Addresses:");
    console.log(`Pool:            ${poolContract.address}`);
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

export async function deployPools(onlyDeployPoolName?: PoolName) {
    const poolsToDeploy: {
        creditContract: CreditContractName;
        manager: CreditManagerContractName;
        poolName: PoolName;
    }[] = [
        {
            creditContract: "CreditLine",
            manager: "CreditLineManager",
            poolName: PoolName.CreditLine,
        },
        {
            creditContract: "ReceivableBackedCreditLine",
            manager: "ReceivableBackedCreditLineManager",
            poolName: PoolName.ArfV2,
        },
        // Add more pools as needed
    ];

    try {
        if (onlyDeployPoolName) {
            const poolToDeploy = poolsToDeploy.find(
                (pool) => pool.poolName === onlyDeployPoolName,
            );
            if (poolToDeploy) {
                await deployPool(
                    poolToDeploy.creditContract,
                    poolToDeploy.manager,
                    poolToDeploy.poolName,
                );
            } else {
                console.error(`Pool with name '${onlyDeployPoolName}' not found.`);
                process.exitCode = 1;
            }
        } else {
            for (const pool of poolsToDeploy) {
                await deployPool(pool.creditContract, pool.manager, pool.poolName);
            }
        }
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}
