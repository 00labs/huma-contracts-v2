import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
    checkEpochInfo,
    CONSTANTS,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    getNextDueDate,
    PnLCalculator,
} from "./BaseTest";
import {
    copyLPConfigWithOverrides,
    getFirstLossCoverInfo,
    mineNextBlockWithTimestamp,
    setNextBlockTimestamp,
    sumBNArray,
    toToken,
} from "./TestUtils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    Calendar,
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
    ProfitEscrow,
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
let lender: SignerWithAddress, lender2: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager;

async function getMinJuniorAssets(
    seniorMatureRedemptionInThisEpoch: number | BN,
    maxSeniorJuniorRatio: number,
) {
    let seniorAssets = await seniorTrancheVaultContract.totalAssets();
    seniorAssets = seniorAssets.sub(seniorMatureRedemptionInThisEpoch);
    let minJuniorAssets = seniorAssets.div(maxSeniorJuniorRatio);
    if (minJuniorAssets.mul(maxSeniorJuniorRatio).lt(seniorAssets)) {
        minJuniorAssets = minJuniorAssets.add(1);
    }
    return minJuniorAssets;
}

async function getMaxJuniorProcessed(
    seniorMatureRedemptionInThisEpoch: BN | number,
    maxSeniorJuniorRatio: number,
) {
    const minJuniorAssets = await getMinJuniorAssets(
        seniorMatureRedemptionInThisEpoch,
        maxSeniorJuniorRatio,
    );
    const juniorAssets = await juniorTrancheVaultContract.totalAssets();
    return juniorAssets.sub(minJuniorAssets);
}

describe("EpochManager Test", function () {
    before(async function () {
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
            lender,
            lender2,
        ] = await ethers.getSigners();
    });

    async function prepare() {
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
            affiliateFirstLossCoverProfitEscrowContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditFeeManagerContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, lender2],
        );

        let juniorDepositAmount = toToken(400_000);
        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(juniorDepositAmount, lender.address);
        let seniorDepositAmount = toToken(10_000);
        await seniorTrancheVaultContract
            .connect(lender)
            .deposit(seniorDepositAmount, lender.address);

        juniorDepositAmount = toToken(50_000);
        await juniorTrancheVaultContract
            .connect(lender2)
            .deposit(juniorDepositAmount, lender2.address);
        seniorDepositAmount = toToken(20_000);
        await seniorTrancheVaultContract
            .connect(lender2)
            .deposit(seniorDepositAmount, lender2.address);
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should not allow non-Pool to start new epoch", async function () {
        await expect(epochManagerContract.startNewEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "notPool",
        );
    });

    it("Should start a new epoch", async function () {
        const settings = await poolConfigContract.getPoolSettings();

        // Starts a new epoch
        let lastEpoch = await epochManagerContract.currentEpoch();
        let [endTime] = getNextDueDate(
            0,
            Math.ceil(Date.now() / 1000),
            settings.payPeriodInMonths,
        );
        await expect(poolContract.connect(poolOwner).enablePool())
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        // Goes forward one day and start a new epoch
        let ts = endTime + 60 * 5;
        await mineNextBlockWithTimestamp(ts);
        lastEpoch = await epochManagerContract.currentEpoch();
        [endTime] = getNextDueDate(0, ts, settings.payPeriodInMonths);
        await expect(poolContract.connect(poolOwner).enablePool())
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);
    });

    it("Should not close an epoch when the protocol is paused or the pool is off", async function () {
        await humaConfigContract.connect(protocolOwner).pause();
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "protocolIsPaused",
        );
        await humaConfigContract.connect(protocolOwner).unpause();

        await poolContract.connect(poolOwner).disablePool();
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "poolIsNotOn",
        );
        await poolContract.connect(poolOwner).enablePool();
    });

    it("Should not close an epoch before end time", async function () {
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            epochManagerContract,
            "closeTooSoon",
        );
    });

    async function getAssetsAfterProfitAndLoss(profit: BN, loss: BN, lossRecovery: BN) {
        const adjustment = 8000;
        const lpConfig = await poolConfigContract.getLPConfig();
        const newLpConfig = copyLPConfigWithOverrides(lpConfig, {
            tranchesRiskAdjustmentInBps: adjustment,
        });
        await poolConfigContract.connect(poolOwner).setLPConfig(newLpConfig);

        const assetInfo = await poolContract.tranchesAssets();
        const assets = [assetInfo[CONSTANTS.SENIOR_TRANCHE], assetInfo[CONSTANTS.JUNIOR_TRANCHE]];
        const profitAfterFees = await poolFeeManagerContract.calcPoolFeeDistribution(profit);
        const firstLossCoverInfos = await Promise.all(
            [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                async (contract) => await getFirstLossCoverInfo(contract, poolConfigContract),
            ),
        );

        return await PnLCalculator.calcRiskAdjustedProfitAndLoss(
            profitAfterFees,
            loss,
            lossRecovery,
            assets,
            BN.from(adjustment),
            firstLossCoverInfos,
        );
    }

    async function testCloseEpoch(
        totalSeniorSharesRequested: BN,
        seniorSharesRedeemable: BN,
        totalJuniorSharesRequested: BN,
        juniorSharesRedeemable: BN,
        profit: BN = BN.from(0),
        loss: BN = BN.from(0),
        lossRecovery: BN = BN.from(0),
        delta: number = 0,
    ) {
        const settings = await poolConfigContract.getPoolSettings();

        const lastEpoch = await epochManagerContract.currentEpoch();
        const ts = lastEpoch.endTime.toNumber() + 60 * 5;
        await setNextBlockTimestamp(ts);
        const [endTime] = getNextDueDate(
            lastEpoch.endTime.toNumber(),
            ts,
            settings.payPeriodInMonths,
        );

        const [[seniorAssets, juniorAssets]] = await getAssetsAfterProfitAndLoss(
            profit,
            loss,
            lossRecovery,
        );
        const seniorTotalSupply = await seniorTrancheVaultContract.totalSupply();
        const seniorTokenPrice = seniorAssets
            .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
            .div(seniorTotalSupply);
        const seniorAmountRedeemable = seniorSharesRedeemable
            .mul(seniorTokenPrice)
            .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
        const unprocessedSeniorAmount = totalSeniorSharesRequested
            .sub(seniorSharesRedeemable)
            .mul(seniorTokenPrice)
            .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
        console.log(`Unprocessed senior amount: ${unprocessedSeniorAmount}`);
        const expectedSeniorAssets = seniorAssets.sub(seniorAmountRedeemable);
        const seniorTokenBalance = await mockTokenContract.balanceOf(
            seniorTrancheVaultContract.address,
        );

        const juniorTotalSupply = await juniorTrancheVaultContract.totalSupply();
        const juniorTokenPrice = juniorAssets
            .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
            .div(juniorTotalSupply);
        const juniorAmountRedeemable = juniorSharesRedeemable
            .mul(juniorTokenPrice)
            .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
        const unprocessedJuniorAmount = totalJuniorSharesRequested
            .sub(juniorSharesRedeemable)
            .mul(juniorTokenPrice)
            .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
        const expectedJuniorAssets = juniorAssets.sub(juniorAmountRedeemable);
        const juniorTokenBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.address,
        );

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        // Ensure that the remaining assets and supply match the expected amount.
        expect(await seniorTrancheVaultContract.totalAssets()).to.be.closeTo(
            expectedSeniorAssets,
            delta,
        );
        expect(await seniorTrancheVaultContract.totalSupply()).to.be.closeTo(
            seniorTotalSupply.sub(seniorSharesRedeemable),
            delta,
        );
        expect(
            await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
        ).to.be.closeTo(seniorTokenBalance.add(seniorAmountRedeemable), delta);
        expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
            expectedJuniorAssets,
            delta,
        );
        expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
            juniorTotalSupply.sub(juniorSharesRedeemable),
            delta,
        );
        expect(
            await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
        ).to.be.closeTo(juniorTokenBalance.add(juniorAmountRedeemable), delta);
    }

    describe("Non-flex call tests", function () {
        it("Should close an epoch successfully after processing one senior redemption request fully", async function () {
            const sharesToRedeem = toToken(2539);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);

            await testCloseEpoch(sharesToRedeem, sharesToRedeem, BN.from(0), BN.from(0));
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        });

        it("Should close epochs successfully after processing multiple senior redemption requests fully", async function () {
            // Move all assets out of pool safe so that no redemption request can be fulfilled initially.
            const availableAssets = await poolSafeContract.getPoolLiquidity();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Epoch 1
            const sharesToRedeemInEpoch1 = toToken(236);
            await seniorTrancheVaultContract
                .connect(lender)
                .addRedemptionRequest(sharesToRedeemInEpoch1);
            await testCloseEpoch(sharesToRedeemInEpoch1, BN.from(0), BN.from(0), BN.from(0));

            // Epoch 2
            const sharesToRedeemInEpoch2 = toToken(1357);
            const allShares = sharesToRedeemInEpoch1.add(sharesToRedeemInEpoch2);
            // Let the borrower make payment in full so that all redemption requests can be fulfilled.
            await creditContract.makePayment(ethers.constants.HashZero, allShares);
            await seniorTrancheVaultContract
                .connect(lender)
                .addRedemptionRequest(sharesToRedeemInEpoch2);
            await testCloseEpoch(allShares, allShares, BN.from(0), BN.from(0));

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        });

        it(
            "Should close epochs successfully after processing multiple senior redemption requests" +
                " (some are processed fully, some are processed partially and some are unprocessed)",
            async function () {
                // Move all assets out of pool safe so that no redemption request can be fulfilled initially.
                const availableAssets = await poolSafeContract.getPoolLiquidity();
                await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                // Epoch 1.
                let sharesToRedeem = toToken(376);
                let sharesRedeemable = sharesToRedeem;
                let allShares = sharesToRedeem;
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(allShares, BN.from(0), BN.from(0), BN.from(0));

                // Epoch 2
                sharesToRedeem = toToken(865);
                sharesRedeemable = sharesRedeemable.add(sharesToRedeem);
                allShares = allShares.add(sharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(allShares, BN.from(0), BN.from(0), BN.from(0));

                // Epoch 3
                sharesToRedeem = toToken(637);
                sharesRedeemable = sharesRedeemable.add(toToken(169));
                allShares = allShares.add(sharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(allShares, BN.from(0), BN.from(0), BN.from(0));

                // Epoch 4. The borrower makes a partial payment so that some redemption requests can be fulfilled.
                await creditContract.makePayment(ethers.constants.HashZero, sharesRedeemable);
                sharesToRedeem = toToken(497);
                allShares = allShares.add(sharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(allShares, sharesRedeemable, BN.from(0), BN.from(0));

                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );
                expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            },
        );

        it("Should close epochs successfully after processing one junior redemption request fully", async function () {
            const sharesToRedeem = toToken(7363);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(BN.from(0), BN.from(0), sharesToRedeem, sharesToRedeem);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        });

        it("Should close epochs successfully after processing multiple junior redemption requests fully", async function () {
            const availableAssets = await poolSafeContract.getPoolLiquidity();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Epoch 1
            let sharesToRedeem = toToken(396);
            let allShares = sharesToRedeem;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(BN.from(0), BN.from(0), allShares, BN.from(0));
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);

            // Epoch 2
            sharesToRedeem = toToken(873);
            allShares = allShares.add(sharesToRedeem);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(BN.from(0), BN.from(0), allShares, BN.from(0));
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);

            // Epoch 3
            sharesToRedeem = toToken(4865);
            allShares = allShares.add(sharesToRedeem);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await creditContract.makePayment(ethers.constants.HashZero, allShares);
            await testCloseEpoch(BN.from(0), BN.from(0), allShares, allShares);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        });

        it(
            "Should close epochs successfully after processing multiple junior redemption requests" +
                " (some are processed fully, some are processed partially and some are unprocessed)",
            async function () {
                const availableAssets = await poolSafeContract.getPoolLiquidity();
                await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                // Epoch 1
                let sharesToRedeem = toToken(1628);
                let sharesRedeemable = sharesToRedeem;
                let allShares = sharesToRedeem;
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(BN.from(0), BN.from(0), allShares, BN.from(0));

                // Epoch 2
                sharesToRedeem = toToken(3748);
                allShares = allShares.add(sharesToRedeem);
                sharesRedeemable = sharesRedeemable.add(toToken(2637));
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(BN.from(0), BN.from(0), allShares, BN.from(0));

                // Epoch 3
                sharesToRedeem = toToken(8474);
                allShares = allShares.add(sharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(BN.from(0), BN.from(0), allShares, BN.from(0));

                // Epoch 4
                sharesToRedeem = toToken(7463);
                allShares = allShares.add(sharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await creditContract.makePayment(ethers.constants.HashZero, sharesRedeemable);
                await testCloseEpoch(BN.from(0), BN.from(0), allShares, sharesRedeemable);

                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    3,
                );
                expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            },
        );

        it("Should close epochs successfully after processing one senior and one junior redemption request fully", async function () {
            const sharesToRedeem = toToken(1000);
            await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(sharesToRedeem);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);

            await testCloseEpoch(sharesToRedeem, sharesToRedeem, sharesToRedeem, sharesToRedeem);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);

            const seniorEpoch = await seniorTrancheVaultContract.epochInfoByEpochId(1);
            checkEpochInfo(
                seniorEpoch,
                BN.from(1),
                sharesToRedeem,
                sharesToRedeem,
                sharesToRedeem,
            );
            const juniorEpoch = await juniorTrancheVaultContract.epochInfoByEpochId(1);
            checkEpochInfo(
                juniorEpoch,
                BN.from(1),
                sharesToRedeem,
                sharesToRedeem,
                sharesToRedeem,
            );
        });

        it(
            "Should close epochs successfully after processing multiple redemption requests" +
                " (multiple senior epochs are processed fully, multiple junior epochs are processed fully)",
            async function () {
                const availableAssets = await poolSafeContract.getPoolLiquidity();
                await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                // Epoch 1
                let juniorSharesToRedeem = toToken(1628);
                let allJuniorShares = juniorSharesToRedeem;
                let allShares = juniorSharesToRedeem;
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(juniorSharesToRedeem);

                let seniorSharesToRedeem = toToken(357);
                let allSeniorShares = seniorSharesToRedeem;
                allShares = allShares.add(seniorSharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(seniorSharesToRedeem);

                await testCloseEpoch(allSeniorShares, BN.from(0), allJuniorShares, BN.from(0));

                // Epoch 2
                juniorSharesToRedeem = toToken(3653);
                allShares = allShares.add(juniorSharesToRedeem);
                allJuniorShares = allJuniorShares.add(juniorSharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(juniorSharesToRedeem);
                seniorSharesToRedeem = toToken(2536);
                allShares = allShares.add(seniorSharesToRedeem);
                allSeniorShares = allSeniorShares.add(seniorSharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(seniorSharesToRedeem);
                await testCloseEpoch(allSeniorShares, BN.from(0), allJuniorShares, BN.from(0));

                // Epoch 3
                juniorSharesToRedeem = toToken(9474);
                allShares = allShares.add(juniorSharesToRedeem);
                allJuniorShares = allJuniorShares.add(juniorSharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(juniorSharesToRedeem);
                seniorSharesToRedeem = toToken(736);
                allShares = allShares.add(seniorSharesToRedeem);
                allSeniorShares = allSeniorShares.add(seniorSharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(seniorSharesToRedeem);
                await testCloseEpoch(allSeniorShares, BN.from(0), allJuniorShares, BN.from(0));

                // Epoch 4
                await creditContract.makePayment(ethers.constants.HashZero, allShares);
                await testCloseEpoch(
                    allSeniorShares,
                    allSeniorShares,
                    allJuniorShares,
                    allJuniorShares,
                );

                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
                expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
                expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
            },
        );

        it(
            "Should close epochs successfully after processing multiple redemption requests" +
                " (multiple senior epochs are processed fully," +
                " some junior epochs are processed fully, some are processed partially" +
                " and some are unprocessed)",
            async function () {
                // Epoch 1
                // All senior redemption requests are fulfilled in this epoch, while only some of the junior
                // redemption requests can be fulfilled.
                let seniorSharesToRedeem = toToken(1938);
                let totalSeniorSharesToRedeem = seniorSharesToRedeem;
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(seniorSharesToRedeem);
                let juniorSharesToRedeem = toToken(4637);
                let totalJuniorSharesToRedeem = juniorSharesToRedeem;
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(juniorSharesToRedeem);

                // Move paid amount out of the pool safe so that only the desired number of shares can be redeemed.
                const totalAssets = await poolSafeContract.getPoolLiquidity();
                let seniorSharesRedeemable = seniorSharesToRedeem;
                let juniorSharesRedeemable = toToken(1349);
                await creditContract.drawdown(
                    ethers.constants.HashZero,
                    totalAssets.sub(juniorSharesRedeemable.add(seniorSharesRedeemable)),
                );

                await testCloseEpoch(
                    seniorSharesToRedeem,
                    seniorSharesRedeemable,
                    juniorSharesToRedeem,
                    juniorSharesRedeemable,
                );

                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
                expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1,
                );
                expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
                totalSeniorSharesToRedeem = totalSeniorSharesToRedeem.sub(seniorSharesRedeemable);
                totalJuniorSharesToRedeem = totalJuniorSharesToRedeem.sub(juniorSharesRedeemable);

                // Epoch 2
                // All redemption requests are fulfilled in this epoch, including previously unfulfilled ones.
                juniorSharesToRedeem = toToken(8524);
                totalJuniorSharesToRedeem = totalJuniorSharesToRedeem.add(juniorSharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(juniorSharesToRedeem);

                seniorSharesRedeemable = totalSeniorSharesToRedeem;
                juniorSharesRedeemable = totalJuniorSharesToRedeem;
                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    juniorSharesRedeemable.add(seniorSharesRedeemable),
                );
                await testCloseEpoch(
                    totalSeniorSharesToRedeem,
                    seniorSharesRedeemable,
                    totalJuniorSharesToRedeem,
                    juniorSharesRedeemable,
                );

                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
                expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
                expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
                totalSeniorSharesToRedeem = totalSeniorSharesToRedeem.sub(seniorSharesRedeemable);
                totalJuniorSharesToRedeem = totalJuniorSharesToRedeem.sub(juniorSharesRedeemable);

                // Epoch 3
                // No redemption request is fulfilled in this epoch.
                seniorSharesToRedeem = toToken(268);
                totalSeniorSharesToRedeem = totalSeniorSharesToRedeem.add(seniorSharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(seniorSharesToRedeem);
                juniorSharesToRedeem = toToken(1837);
                totalJuniorSharesToRedeem = totalJuniorSharesToRedeem.add(juniorSharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(juniorSharesToRedeem);
                await testCloseEpoch(
                    totalSeniorSharesToRedeem,
                    BN.from(0),
                    totalJuniorSharesToRedeem,
                    BN.from(0),
                );

                // Epoch 4
                // All senior redemption requests are fulfilled in this epoch, while only some of the junior
                // redemption requests can be fulfilled.
                seniorSharesToRedeem = toToken(736);
                totalSeniorSharesToRedeem = totalSeniorSharesToRedeem.add(seniorSharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(seniorSharesToRedeem);
                juniorSharesToRedeem = toToken(4697);
                totalJuniorSharesToRedeem = totalJuniorSharesToRedeem.add(juniorSharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(juniorSharesToRedeem);

                seniorSharesRedeemable = totalSeniorSharesToRedeem;
                juniorSharesRedeemable = toToken(195);
                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    seniorSharesRedeemable.add(juniorSharesRedeemable),
                );
                await testCloseEpoch(
                    totalSeniorSharesToRedeem,
                    seniorSharesRedeemable,
                    totalJuniorSharesToRedeem,
                    juniorSharesRedeemable,
                );

                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );
                expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
                expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
            },
        );

        describe("With PnL", function () {
            async function makePaymentForRedeemableShares(
                profit: BN,
                loss: BN,
                lossRecovery: BN,
                seniorSharesToRedeem: BN = BN.from(0),
                juniorSharesToRedeem: BN = BN.from(0),
            ) {
                // Based on the given PnL, make just enough payment to allow the desired number of shares
                // to be redeemed.
                await creditContract.setRefreshPnLReturns(profit, loss, lossRecovery);
                // Calculate how much payment we need to make into the pool.
                const [
                    [seniorAssets, juniorAssets],
                    ,
                    profitsForFirstLossCovers,
                    lossRecoveredInFirstLossCovers,
                ] = await getAssetsAfterProfitAndLoss(profit, loss, lossRecovery);
                const seniorSupply = await seniorTrancheVaultContract.totalSupply();
                const seniorPrice = seniorAssets
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(seniorSupply);
                const seniorAmountProcessable = seniorSharesToRedeem
                    .mul(seniorPrice)
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
                const juniorSupply = await juniorTrancheVaultContract.totalSupply();
                const juniorPrice = juniorAssets
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(juniorSupply);
                const juniorAmountProcessable = juniorSharesToRedeem
                    .mul(juniorPrice)
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
                const amountProcessable = seniorAmountProcessable.add(juniorAmountProcessable);
                const poolFees = profit.sub(
                    await poolFeeManagerContract.calcPoolFeeDistribution(profit),
                );
                // Payment needs to include pool fees and assets reserved for the profit and loss recovery
                // of first loss covers, since they excluded from the total assets of the pool safe,
                // and they 0 when we made the drawdown in the beginning of this test.
                const paymentNeededForProcessing = amountProcessable.add(
                    sumBNArray([
                        poolFees,
                        ...profitsForFirstLossCovers,
                        ...lossRecoveredInFirstLossCovers,
                    ]),
                );
                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    // Add 1 as buffer because of potential truncation errors due to integer division rounding down.
                    paymentNeededForProcessing.add(1),
                );
            }

            it("Should close an epoch with the correct LP token prices after processing one senior redemption request fully", async function () {
                const sharesToRedeem = toToken(2539);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);

                const profit = toToken(198),
                    loss = toToken(67),
                    lossRecovery = toToken(39);
                await creditContract.setRefreshPnLReturns(profit, loss, lossRecovery);
                await testCloseEpoch(
                    sharesToRedeem,
                    sharesToRedeem,
                    BN.from(0),
                    BN.from(0),
                    profit,
                    loss,
                    lossRecovery,
                );

                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
            });

            it("Should close epochs with the correct LP token prices after processing multiple senior redemption requests fully", async function () {
                // Move all assets out of pool safe so that no redemption request can be fulfilled initially.
                const availableAssets = await poolSafeContract.getPoolLiquidity();
                await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                // Epoch 1
                let sharesToRedeem = toToken(236);
                let allShares = sharesToRedeem;
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(sharesToRedeem, BN.from(0), BN.from(0), BN.from(0));

                // Epoch 2
                sharesToRedeem = toToken(1357);
                allShares = allShares.add(sharesToRedeem);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                // Make payment to the pool so that all requests can be processed.
                const profit = toToken(198),
                    loss = toToken(67),
                    lossRecovery = toToken(39);
                await makePaymentForRedeemableShares(profit, loss, lossRecovery, allShares);
                await testCloseEpoch(
                    allShares,
                    allShares,
                    BN.from(0),
                    BN.from(0),
                    profit,
                    loss,
                    lossRecovery,
                );

                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
            });

            it(
                "Should close epochs with the correct LP token prices after processing multiple senior" +
                    " redemption requests (some are processed fully, some are processed partially" +
                    " and some are unprocessed)",
                async function () {
                    // Move all assets out of pool safe so that no redemption request can be fulfilled initially.
                    const availableAssets = await poolSafeContract.getPoolLiquidity();
                    await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                    // Epoch 1
                    // This request will be fully processed in the final epoch.
                    const sharesInEpoch1 = toToken(865);
                    await seniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(sharesInEpoch1);
                    await testCloseEpoch(sharesInEpoch1, BN.from(0), BN.from(0), BN.from(0));

                    // Epoch 2
                    // This request will be partially processed in the final epoch.
                    const sharesInEpoch2 = toToken(637);
                    await seniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(sharesInEpoch2);
                    await testCloseEpoch(
                        sharesInEpoch2.add(sharesInEpoch1),
                        BN.from(0),
                        BN.from(0),
                        BN.from(0),
                    );

                    // Introduce PnL.
                    const profit = toToken(198),
                        loss = toToken(67),
                        lossRecovery = toToken(39);
                    const sharesProcessable = sharesInEpoch1.add(toToken(160));
                    await makePaymentForRedeemableShares(
                        profit,
                        loss,
                        lossRecovery,
                        sharesProcessable,
                    );

                    // Epoch 3
                    // This request will be unprocessed in the final epoch.
                    const sharesInEpoch3 = toToken(497);
                    const allShares = sumBNArray([sharesInEpoch1, sharesInEpoch2, sharesInEpoch3]);
                    await seniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(sharesInEpoch3);
                    await testCloseEpoch(
                        allShares,
                        sharesProcessable,
                        BN.from(0),
                        BN.from(0),
                        profit,
                        loss,
                        lossRecovery,
                        1,
                    );

                    expect(
                        (await seniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(2);
                    expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        1,
                    );
                },
            );

            it("Should close epochs with the correct LP token prices successfully after processing one junior redemption request fully", async function () {
                const sharesToRedeem = toToken(1);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);

                const profit = toToken(198),
                    loss = toToken(67),
                    lossRecovery = toToken(39);
                await creditContract.setRefreshPnLReturns(profit, loss, lossRecovery);
                await testCloseEpoch(
                    BN.from(0),
                    BN.from(0),
                    sharesToRedeem,
                    sharesToRedeem,
                    profit,
                    loss,
                    lossRecovery,
                );

                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
            });

            it("Should close epochs with the correct LP token prices successfully after processing multiple junior redemption requests fully", async function () {
                const availableAssets = await poolSafeContract.getPoolLiquidity();
                await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                // Epoch 1
                let sharesToRedeem = toToken(396);
                let allShares = sharesToRedeem;
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(BN.from(0), BN.from(0), allShares, BN.from(0));
                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1,
                );

                // Epoch 2
                sharesToRedeem = toToken(873);
                allShares = allShares.add(sharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                await testCloseEpoch(BN.from(0), BN.from(0), allShares, BN.from(0));
                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );

                // Epoch 3
                sharesToRedeem = toToken(4865);
                allShares = allShares.add(sharesToRedeem);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(sharesToRedeem);
                // Make payment so that all shares can be processed.
                const profit = toToken(198),
                    loss = toToken(67),
                    lossRecovery = toToken(39);
                await makePaymentForRedeemableShares(
                    profit,
                    loss,
                    lossRecovery,
                    BN.from(0),
                    allShares,
                );
                await testCloseEpoch(
                    BN.from(0),
                    BN.from(0),
                    allShares,
                    allShares,
                    profit,
                    loss,
                    lossRecovery,
                );

                expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
            });

            it(
                "Should close epochs with the correct LP token prices successfully after processing multiple" +
                    " junior redemption requests (some are processed fully, some are processed partially" +
                    " and some are unprocessed)",
                async function () {
                    // Move all assets out of pool safe so that no redemption request can be fulfilled initially.
                    const availableAssets = await poolSafeContract.getPoolLiquidity();
                    await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                    // Epoch 1
                    // This request will be fully processed in the final epoch.
                    const sharesInEpoch1 = toToken(1628);
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(sharesInEpoch1);
                    await testCloseEpoch(BN.from(0), BN.from(0), sharesInEpoch1, BN.from(0));

                    // Epoch 2
                    // This request will be partially processed in the final epoch.
                    const sharesInEpoch2 = toToken(3748);
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(sharesInEpoch2);
                    await testCloseEpoch(
                        BN.from(0),
                        BN.from(0),
                        sharesInEpoch1.add(sharesInEpoch2),
                        BN.from(0),
                    );

                    // Introduce PnL.
                    const sharesProcessable = sharesInEpoch1.add(toToken(2637));
                    const profit = toToken(198),
                        loss = toToken(67),
                        lossRecovery = toToken(39);
                    await makePaymentForRedeemableShares(
                        profit,
                        loss,
                        lossRecovery,
                        BN.from(0),
                        sharesProcessable,
                    );

                    // Epoch 3
                    // This request will be unprocessed in the final epoch.
                    const sharesInEpoch3 = toToken(7463);
                    const allShares = sumBNArray([sharesInEpoch1, sharesInEpoch2, sharesInEpoch3]);
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(sharesInEpoch3);
                    await testCloseEpoch(
                        BN.from(0),
                        BN.from(0),
                        allShares,
                        sharesProcessable,
                        profit,
                        loss,
                        lossRecovery,
                        1,
                    );

                    expect(
                        (await juniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(2);
                    expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        1,
                    );
                },
            );

            it(
                "Should close epochs successfully with the correct LP token prices after processing multiple" +
                    " redemption requests (multiple senior epochs are processed fully," +
                    " multiple junior epochs are processed fully)",
                async function () {
                    const availableAssets = await poolSafeContract.getPoolLiquidity();
                    await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                    // Epoch 1
                    let seniorSharesToRedeem = toToken(357);
                    let allSeniorShares = seniorSharesToRedeem;
                    await seniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(seniorSharesToRedeem);
                    let juniorSharesToRedeem = toToken(1628);
                    let allJuniorShares = juniorSharesToRedeem;
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(juniorSharesToRedeem);
                    await testCloseEpoch(allSeniorShares, BN.from(0), allJuniorShares, BN.from(0));

                    // Epoch 2
                    seniorSharesToRedeem = toToken(2536);
                    allSeniorShares = allSeniorShares.add(seniorSharesToRedeem);
                    await seniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(seniorSharesToRedeem);
                    juniorSharesToRedeem = toToken(3653);
                    allJuniorShares = allJuniorShares.add(juniorSharesToRedeem);
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(juniorSharesToRedeem);
                    await testCloseEpoch(allSeniorShares, BN.from(0), allJuniorShares, BN.from(0));

                    // Epoch 3
                    seniorSharesToRedeem = toToken(736);
                    allSeniorShares = allSeniorShares.add(seniorSharesToRedeem);
                    await seniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(seniorSharesToRedeem);
                    juniorSharesToRedeem = toToken(9474);
                    allJuniorShares = allJuniorShares.add(juniorSharesToRedeem);
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(juniorSharesToRedeem);
                    await testCloseEpoch(allSeniorShares, BN.from(0), allJuniorShares, BN.from(0));

                    // Introduce PnL.
                    const profit = toToken(198),
                        loss = toToken(67),
                        lossRecovery = toToken(39);
                    await makePaymentForRedeemableShares(
                        profit,
                        loss,
                        lossRecovery,
                        allSeniorShares,
                        allJuniorShares,
                    );

                    // Epoch 4
                    await testCloseEpoch(
                        allSeniorShares,
                        allSeniorShares,
                        allJuniorShares,
                        allJuniorShares,
                        profit,
                        loss,
                        lossRecovery,
                        2,
                    );

                    expect(
                        (await seniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(0);
                    expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        3,
                    );
                    expect(
                        (await juniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(0);
                    expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        3,
                    );
                },
            );

            it(
                "Should close epochs successfully with the correct LP token prices after processing multiple" +
                    " redemption requests (multiple senior redemption requests are processed fully," +
                    " some junior redemption requests are processed fully," +
                    " some are processed partially and some are unprocessed)",
                async function () {
                    // Move all assets out of the pool safe.
                    const totalAssets = await poolSafeContract.getPoolLiquidity();
                    await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

                    // Epoch 1
                    // Senior redemption requests are fully processed; junior redemption requests are partially processed.
                    const seniorSharesInEpoch1 = toToken(1938);
                    await seniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(seniorSharesInEpoch1);
                    let totalSeniorSharesToRedeem = seniorSharesInEpoch1;
                    const juniorSharesInEpoch1 = toToken(4637);
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(juniorSharesInEpoch1);
                    let totalJuniorSharesToRedeem = juniorSharesInEpoch1;
                    let seniorSharesRedeemable = seniorSharesInEpoch1,
                        juniorSharesRedeemable = toToken(1349);
                    // Introduce PnL.
                    const profitInEpoch1 = toToken(198),
                        lossInEpoch1 = toToken(67),
                        lossRecoveryInEpoch1 = toToken(39);
                    await makePaymentForRedeemableShares(
                        profitInEpoch1,
                        lossInEpoch1,
                        lossRecoveryInEpoch1,
                        seniorSharesRedeemable,
                        juniorSharesRedeemable,
                    );
                    await testCloseEpoch(
                        totalSeniorSharesToRedeem,
                        seniorSharesRedeemable,
                        totalJuniorSharesToRedeem,
                        juniorSharesRedeemable,
                        profitInEpoch1,
                        lossInEpoch1,
                        lossRecoveryInEpoch1,
                        1,
                    );
                    expect(
                        (await seniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(0);
                    expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        1,
                    );
                    expect(
                        (await juniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(1);
                    expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        0,
                    );
                    totalSeniorSharesToRedeem =
                        totalSeniorSharesToRedeem.sub(seniorSharesRedeemable);
                    totalJuniorSharesToRedeem =
                        totalJuniorSharesToRedeem.sub(juniorSharesRedeemable);

                    // Epoch 2
                    // Submit more redemption requests and have them fully processed.
                    const juniorSharesInEpoch2 = toToken(8524);
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(juniorSharesInEpoch2);
                    totalJuniorSharesToRedeem =
                        totalJuniorSharesToRedeem.add(juniorSharesInEpoch2);
                    seniorSharesRedeemable = totalSeniorSharesToRedeem;
                    juniorSharesRedeemable = totalJuniorSharesToRedeem;
                    // Introduce more PnL.
                    const profitInEpoch2 = toToken(784),
                        lossInEpoch2 = toToken(142),
                        lossRecoveryInEpoch2 = toToken(77);
                    await makePaymentForRedeemableShares(
                        profitInEpoch2,
                        lossInEpoch2,
                        lossRecoveryInEpoch2,
                        seniorSharesRedeemable,
                        juniorSharesRedeemable,
                    );
                    await testCloseEpoch(
                        totalSeniorSharesToRedeem,
                        seniorSharesRedeemable,
                        totalJuniorSharesToRedeem,
                        juniorSharesRedeemable,
                        profitInEpoch2,
                        lossInEpoch2,
                        lossRecoveryInEpoch2,
                        1,
                    );
                    expect(
                        (await seniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(0);
                    expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        1,
                    );
                    expect(
                        (await juniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(0);
                    expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        2,
                    );
                    totalSeniorSharesToRedeem =
                        totalSeniorSharesToRedeem.sub(seniorSharesRedeemable);
                    totalJuniorSharesToRedeem =
                        totalJuniorSharesToRedeem.sub(juniorSharesRedeemable);

                    // Epoch 3
                    // No redemption request is processed in this epoch.
                    const juniorSharesInEpoch3 = toToken(1837);
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(juniorSharesInEpoch3);
                    totalJuniorSharesToRedeem =
                        totalJuniorSharesToRedeem.add(juniorSharesInEpoch3);
                    juniorSharesRedeemable = BN.from(0);
                    await testCloseEpoch(
                        totalSeniorSharesToRedeem,
                        seniorSharesRedeemable,
                        totalJuniorSharesToRedeem,
                        juniorSharesRedeemable,
                        BN.from(0),
                        BN.from(0),
                        BN.from(0),
                        1,
                    );
                    expect(
                        (await seniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(0);
                    expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        1,
                    );
                    expect(
                        (await juniorTrancheVaultContract.unprocessedEpochInfos()).length,
                    ).to.equal(1);
                    expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(
                        2,
                    );
                },
            );
        });
    });
});
