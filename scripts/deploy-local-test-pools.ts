import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";

import {
    CreditContractName,
    CreditManagerContractName,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    PayPeriodDuration,
} from "../test/BaseTest";
import { CONSTANTS, LocalPoolName } from "../test/constants";
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
    Receivable,
    ReceivableBackedCreditLine,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import { advanceChainTime } from "./utils";

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
    adminFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine | ReceivableBackedCreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: CreditLineManager,
    receivableContract: Receivable;

const poolsToDeploy: {
    creditContract: CreditContractName;
    manager: CreditManagerContractName;
    poolName: LocalPoolName;
}[] = [
    {
        creditContract: "CreditLine",
        manager: "CreditLineManager",
        poolName: LocalPoolName.CreditLine,
    },
    {
        creditContract: "ReceivableBackedCreditLine",
        manager: "ReceivableBackedCreditLineManager",
        poolName: LocalPoolName.ReceivableBackedCreditLine,
    },
    // Add more pools as needed
];

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
    poolName?: LocalPoolName,
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
        adminFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract as unknown,
        creditDueManagerContract,
        creditManagerContract as unknown,
        receivableContract,
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
        [juniorLender, seniorLender, lenderRedemptionActive, borrowerActive],
    );

    // Deposit first loss cover
    await depositFirstLossCover(borrowerFirstLossCoverContract, borrowerActive);

    // Set first loss cover liquidity cap
    const totalAssetsBorrowerFLC = await borrowerFirstLossCoverContract.totalAssets();
    const totalAssetsAdminFLC = await adminFirstLossCoverContract.totalAssets();
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
        adminFirstLossCoverContract,
        CONSTANTS.ADMIN_LOSS_COVER_INDEX,
        poolConfigContract,
        poolOwner,
        {
            maxLiquidity: totalAssetsAdminFLC.add(yieldAmount),
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

    if (poolName === LocalPoolName.CreditLine) {
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
        await (creditContract as CreditLine)
            .connect(borrowerActive)
            .drawdown(borrowerActive.address, borrowAmount);
    } else if (poolName === LocalPoolName.ReceivableBackedCreditLine) {
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

        const currentBlockTimestamp = await time.latest();
        await receivableContract
            .connect(borrowerActive)
            .createReceivable(
                1,
                borrowAmount,
                moment.unix(currentBlockTimestamp).add(7, "days").hour(0).unix(),
                "",
                "",
            );
        const receivableId = await receivableContract.tokenOfOwnerByIndex(
            borrowerActive.address,
            0,
        );
        await receivableContract
            .connect(borrowerActive)
            .approve(creditContract.address, receivableId);
        await (creditContract as ReceivableBackedCreditLine)
            .connect(borrowerActive)
            .drawdownWithReceivable(borrowerActive.address, receivableId, borrowAmount);
    }

    console.log("=====================================");
    console.log("Accounts:");
    console.log(`Junior lender:      ${juniorLender.address}`);
    console.log(`Senior lender:      ${seniorLender.address}`);
    console.log(`Borrower:           ${borrowerActive.address}`);
    console.log(`Sentinel Service:   ${sentinelServiceAccount.address}`);
    console.log(`Pool owner:         ${poolOwner.address}`);
    console.log(`EA service:         ${eaServiceAccount.address}`);

    console.log("-------------------------------------");
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
    console.log(`Admin FLC:       ${adminFirstLossCoverContract.address}`);
    if (poolName === LocalPoolName.ReceivableBackedCreditLine) {
        console.log(`Receivable:      ${receivableContract.address}`);
    }

    console.log("=====================================");
}

export async function deployPools(
    onlyDeployPoolName: LocalPoolName | undefined = undefined,
    shouldAdvanceTime: boolean = true,
) {
    try {
        if (shouldAdvanceTime) {
            // always set the date to the 1st of the next month
            const blockchainStartDate = moment().utc().add(1, "month").startOf("month");
            await advanceChainTime(blockchainStartDate);
        }

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
