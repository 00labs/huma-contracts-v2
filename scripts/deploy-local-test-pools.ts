import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";

import { getAccountSigners } from "../tasks/utils";
import {
    CreditContractName,
    CreditContractType,
    CreditManagerContractName,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    PayPeriodDuration,
} from "../test/BaseTest";
import { CONSTANTS, LocalPoolName } from "../test/constants";
import { overrideFirstLossCoverConfig, toToken } from "../test/TestUtils";
import {
    CreditLine,
    CreditLineManager,
    EpochManager,
    FirstLossCover,
    MockToken,
    Pool,
    PoolConfig,
    PoolSafe,
    ReceivableBackedCreditLine,
    ReceivableBackedCreditLineManager,
    TrancheVault,
} from "../typechain-types";
import { advanceChainToTime } from "./utils";

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

async function depositFirstLossCover(
    coverContract: FirstLossCover,
    mockTokenContract: MockToken,
    poolOwner: SignerWithAddress,
    account: SignerWithAddress,
) {
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
): Promise<{
    poolContract: Pool;
    poolConfigContract: PoolConfig;
    poolSafeContract: PoolSafe;
    creditContract: CreditContractType;
    epochManagerContract: EpochManager;
    juniorTrancheVaultContract: TrancheVault;
    seniorTrancheVaultContract: TrancheVault;
    mockTokenContract: MockToken;
}> {
    console.log("=====================================");
    console.log(`Deploying pool with ${creditContractName} and ${creditManagerContractName}`);
    if (poolName) {
        console.log(`Pool name: ${poolName}`);
    }
    console.log(`Starting block timestamp: ${await time.latest()}`);
    const {
        defaultDeployer,
        protocolOwner,
        treasury,
        sentinelServiceAccount,
        poolOwner,
        poolOwnerTreasury,
        evaluationAgent,
        poolOperator,
        juniorLender,
        seniorLender,
        lenderRedemptionActive,
        borrowerActive,
        borrowerInactive,
    } = await getAccountSigners(ethers);

    console.log("Deploying and setting up protocol contracts");
    const [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
        protocolOwner,
        treasury,
        sentinelServiceAccount,
        poolOwner,
    );

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
    ] = await deployAndSetupPoolContracts(
        humaConfigContract,
        mockTokenContract,
        "RiskAdjustedTranchesPolicy",
        defaultDeployer,
        poolOwner,
        creditContractName,
        creditManagerContractName,
        evaluationAgent,
        treasury,
        poolOwnerTreasury,
        poolOperator,
        [juniorLender, seniorLender, lenderRedemptionActive, borrowerActive, borrowerInactive],
    );

    // Deposit first loss cover
    await depositFirstLossCover(
        borrowerFirstLossCoverContract,
        mockTokenContract,
        poolOwner,
        borrowerActive,
    );

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
    await juniorTrancheVaultContract.connect(juniorLender).deposit(toToken(150_000));
    await seniorTrancheVaultContract.connect(seniorLender).deposit(toToken(200_000));

    const frontLoadingFeeFlat = toToken(100);
    const frontLoadingFeeBps = BN.from(100);
    await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
        frontLoadingFeeFlat: frontLoadingFeeFlat,
        frontLoadingFeeBps: frontLoadingFeeBps,
    });

    if (poolName === LocalPoolName.CreditLine) {
        console.log("Drawing down from CreditLine");
        await (creditManagerContract as CreditLineManager)
            .connect(evaluationAgent)
            .approveBorrower(
                borrowerActive.address,
                toToken(100_000),
                5, // numOfPeriods
                1217, // yieldInBps
                toToken(0),
                0,
                true,
            );
        await (creditManagerContract as CreditLineManager)
            .connect(evaluationAgent)
            .approveBorrower(
                borrowerInactive.address,
                toToken(100_000),
                5, // numOfPeriods
                1217, // yieldInBps
                toToken(0),
                0,
                true,
            );
        const borrowAmount = toToken(100_000);

        // Drawing down credit line
        await (creditContract as CreditLine).connect(borrowerActive).drawdown(borrowAmount);
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

        console.log("Drawing down from ReceivableBackedCreditLine");
        await (creditManagerContract as ReceivableBackedCreditLineManager)
            .connect(evaluationAgent)
            .approveBorrower(
                borrowerActive.address,
                toToken(100_000),
                5, // numOfPeriods
                1217, // yieldInBps
                toToken(0),
                0,
                true,
            );
        await (creditManagerContract as ReceivableBackedCreditLineManager)
            .connect(evaluationAgent)
            .approveBorrower(
                borrowerInactive.address,
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
            .drawdownWithReceivable(receivableId, borrowAmount);
    }

    console.log("=====================================");
    console.log("Accounts:");
    console.log(`Junior lender:      ${juniorLender.address}`);
    console.log(`Senior lender:      ${seniorLender.address}`);
    console.log(`Borrower:           ${borrowerActive.address}`);
    console.log(`Inactive Borrower:  ${borrowerInactive.address}`);
    console.log(`Sentinel Service:   ${sentinelServiceAccount.address}`);
    console.log(`Pool owner:         ${poolOwner.address}`);
    console.log("-------------------------------------");

    console.log("Addresses:");
    console.log(`Pool:            ${poolContract.address}`);
    console.log(`Epoch manager:   ${epochManagerContract.address}`);
    console.log(`Pool config:     ${poolConfigContract.address}`);
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

    return {
        poolContract,
        epochManagerContract,
        poolSafeContract,
        creditContract,
        poolConfigContract,
        juniorTrancheVaultContract,
        seniorTrancheVaultContract,
        mockTokenContract,
    };
}

export async function deployPools(
    onlyDeployPoolName: LocalPoolName | undefined = undefined,
    shouldAdvanceTime: boolean = true,
): Promise<
    Array<{
        poolContract: Pool;
        poolSafeContract: PoolSafe;
        epochManagerContract: EpochManager;
        poolConfigContract: PoolConfig;
        creditContract: CreditContractType;
        juniorTrancheVaultContract: TrancheVault;
        seniorTrancheVaultContract: TrancheVault;
        mockTokenContract: MockToken;
    }>
> {
    try {
        const contracts = [];

        if (shouldAdvanceTime) {
            // always set the date to the 1st of the next month
            const blockchainStartDate = moment().utc().add(1, "month").startOf("month");
            await advanceChainToTime(blockchainStartDate);
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
                contracts.push(await deployPool(pool.creditContract, pool.manager, pool.poolName));
            }
        }

        return contracts;
    } catch (error) {
        console.error(error);
        process.exitCode = 1;

        throw error;
    }
}
