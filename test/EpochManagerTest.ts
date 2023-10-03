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
} from "./BaseTest";
import { mineNextBlockWithTimestamp, setNextBlockTimestamp, toToken } from "./TestUtils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    FirstLossCover,
    MockToken,
    PoolFeeManager,
    Pool,
    PoolConfig,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
    ProfitEscrow,
    MockPoolCredit,
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
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

async function getMinJuniorAssets(
    seniorMatureRedemptionInThisEpoch: number | BN,
    maxSeniorJuniorRatio: number,
) {
    let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
    seniorTotalAssets = seniorTotalAssets.sub(seniorMatureRedemptionInThisEpoch);
    let minJuniorAssets = seniorTotalAssets.div(maxSeniorJuniorRatio);
    if (minJuniorAssets.mul(maxSeniorJuniorRatio).lt(seniorTotalAssets)) {
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
            creditPnlManagerContract,
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
            settings.calendarUnit,
            0,
            Math.ceil(Date.now() / 1000),
            settings.payPeriodInCalendarUnit,
        );
        await expect(poolContract.connect(poolOwner).enablePool())
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        // Goes forward one day and start a new epoch
        let ts = endTime + 60 * 5;
        await mineNextBlockWithTimestamp(ts);
        lastEpoch = await epochManagerContract.currentEpoch();
        [endTime] = getNextDueDate(settings.calendarUnit, 0, ts, settings.payPeriodInCalendarUnit);
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

    async function testCloseEpoch(
        unprocessedAmount: BN,
        expectedSeniorAssets: BN,
        expectedJuniorAssets: BN,
    ) {
        const settings = await poolConfigContract.getPoolSettings();

        const lastEpoch = await epochManagerContract.currentEpoch();
        const ts = lastEpoch.endTime.toNumber() + 60 * 5;
        await setNextBlockTimestamp(ts);
        const [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime.toNumber(),
            ts,
            settings.payPeriodInCalendarUnit,
        );

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                expectedSeniorAssets,
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                expectedJuniorAssets,
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                unprocessedAmount,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);
    }

    describe("Non-flex call tests", function () {
        it("Should close an epoch successfully after processing one senior redemption request fully", async function () {
            const sharesToRedeem = toToken(2539);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);

            const seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            const juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(
                BN.from(0),
                seniorTotalAssets.sub(sharesToRedeem),
                juniorTotalAssets,
            );

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(sharesToRedeem),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epochs successfully after processing multiple senior redemption requests fully", async function () {
            // Move all assets out of pool safe so that no redemption request can be fulfilled initially.
            const availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Epoch 1
            let sharesToRedeem = toToken(236);
            let allShares = sharesToRedeem;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            const seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            const juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

            // Epoch 2
            sharesToRedeem = toToken(1357);
            allShares = allShares.add(sharesToRedeem);
            // Let the borrower make payment in full so that all redemption requests can be fulfilled.
            await creditContract.makePayment(ethers.constants.HashZero, allShares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(BN.from(0), seniorTotalAssets.sub(allShares), juniorTotalAssets);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(allShares),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epochs successfully after processing multiple senior redemption requests (\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
            // Move all assets out of pool safe so that no redemption request can be fulfilled initially.
            const availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Epoch 1.
            let sharesToRedeem = toToken(376);
            let partialPaymentAmount = sharesToRedeem;
            let allShares = sharesToRedeem;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            const seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            const juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

            // Epoch 2
            sharesToRedeem = toToken(865);
            partialPaymentAmount = partialPaymentAmount.add(sharesToRedeem);
            allShares = allShares.add(sharesToRedeem);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

            // Epoch 3
            sharesToRedeem = toToken(637);
            partialPaymentAmount = partialPaymentAmount.add(toToken(169));
            allShares = allShares.add(sharesToRedeem);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

            // Epoch 4. The borrower makes a partial payment so that some redemption requests can be fulfilled.
            await creditContract.makePayment(ethers.constants.HashZero, partialPaymentAmount);
            sharesToRedeem = toToken(497);
            allShares = allShares.add(sharesToRedeem);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(
                allShares.sub(partialPaymentAmount),
                seniorTotalAssets.sub(partialPaymentAmount),
                juniorTotalAssets,
            );

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(partialPaymentAmount),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epochs successfully after processing one junior redemption request fully", async function () {
            const sharesToRedeem = toToken(7363);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            const seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            const juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(
                BN.from(0),
                seniorTotalAssets,
                juniorTotalAssets.sub(sharesToRedeem),
            );

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(sharesToRedeem),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epochs successfully after processing multiple junior redemption requests fully", async function () {
            const availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Epoch 1
            let sharesToRedeem = toToken(396);
            let allShares = sharesToRedeem;
            const seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            const juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);

            // Epoch 2
            sharesToRedeem = toToken(873);
            allShares = allShares.add(sharesToRedeem);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);

            // Epoch 3
            sharesToRedeem = toToken(4865);
            allShares = allShares.add(sharesToRedeem);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await creditContract.makePayment(ethers.constants.HashZero, allShares);
            await testCloseEpoch(BN.from(0), seniorTotalAssets, juniorTotalAssets.sub(allShares));

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(allShares),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epochs successfully after processing multiple junior redemption requests (\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
            const availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Epoch 1
            let sharesToRedeem = toToken(1628);
            let partialPaymentAmount = sharesToRedeem;
            let allShares = sharesToRedeem;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            const seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            const juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

            // Epoch 2
            sharesToRedeem = toToken(3748);
            allShares = allShares.add(sharesToRedeem);
            partialPaymentAmount = partialPaymentAmount.add(toToken(2637));
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

            // Epoch 3
            sharesToRedeem = toToken(8474);
            allShares = allShares.add(sharesToRedeem);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

            // Epoch 4
            sharesToRedeem = toToken(7463);
            allShares = allShares.add(sharesToRedeem);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(sharesToRedeem);
            await creditContract.makePayment(ethers.constants.HashZero, partialPaymentAmount);
            await testCloseEpoch(
                allShares.sub(partialPaymentAmount),
                seniorTotalAssets,
                juniorTotalAssets.sub(partialPaymentAmount),
            );

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(partialPaymentAmount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epochs successfully after processing one senior and one junior redemption request fully", async function () {
            const settings = await poolConfigContract.getPoolSettings();

            let withdrawalShares = toToken(1000);
            await juniorTrancheVaultContract
                .connect(lender)
                .addRedemptionRequest(withdrawalShares);
            await seniorTrancheVaultContract
                .connect(lender2)
                .addRedemptionRequest(withdrawalShares);

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await mineNextBlockWithTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorTotalSupply = await juniorTrancheVaultContract.totalSupply();
            let juniorBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorTotalSupply = await seniorTrancheVaultContract.totalSupply();
            let seniorBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(withdrawalShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(withdrawalShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime)
                .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                .withArgs(1, withdrawalShares, withdrawalShares, 1)
                .to.emit(juniorTrancheVaultContract, "EpochsProcessed")
                .withArgs(1, withdrawalShares, withdrawalShares, 1);

            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                juniorTotalSupply.sub(withdrawalShares),
            );
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorBalance.add(withdrawalShares),
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorTotalSupply.sub(withdrawalShares),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorBalance.add(withdrawalShares),
            );

            let epoch = await seniorTrancheVaultContract.epochInfoByEpochId(1);
            checkEpochInfo(
                epoch,
                BN.from(1),
                withdrawalShares,
                withdrawalShares,
                withdrawalShares,
            );
            epoch = await juniorTrancheVaultContract.epochInfoByEpochId(1);
            checkEpochInfo(
                epoch,
                BN.from(1),
                withdrawalShares,
                withdrawalShares,
                withdrawalShares,
            );

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);

            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
        });

        it("Should close epochs successfully after processing multiple redemption requests (\
    multiple senior epochs are processed fully, \
    multiple junior epochs are processed fully", async function () {
            const availableAssets = await poolSafeContract.totalAssets();
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

            const seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            const juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

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
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

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
            await testCloseEpoch(allShares, seniorTotalAssets, juniorTotalAssets);

            // Epoch 4
            await creditContract.makePayment(ethers.constants.HashZero, allShares);
            await testCloseEpoch(
                BN.from(0),
                seniorTotalAssets.sub(allSeniorShares),
                juniorTotalAssets.sub(allJuniorShares),
            );

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(allJuniorShares),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(allSeniorShares),
            );
        });

        it("Should close epochs successfully after processing multiple redemption requests (\
    multiple senior epochs are processed fully, \
    multiple junior epochs are processed partially (\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
            // Epoch 1
            let shares = toToken(4637);
            let unprocessedJuniorShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(1938);
            let unprocessedSeniorShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let unprocessed = unprocessedJuniorShares.add(unprocessedSeniorShares);

            // Move all assets out of pool safe
            let totalAssets = await poolSafeContract.totalAssets();
            let paidSeniorAmount = unprocessedSeniorShares;
            let paidJuniorAmount = toToken(1349);
            let allPaid = paidJuniorAmount.add(paidSeniorAmount);
            await creditContract.drawdown(
                ethers.constants.HashZero,
                totalAssets.sub(paidJuniorAmount.add(paidSeniorAmount)),
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(
                unprocessed.sub(allPaid),
                seniorTotalAssets.sub(paidSeniorAmount),
                juniorTotalAssets.sub(paidJuniorAmount),
            );

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(paidSeniorAmount),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(paidJuniorAmount),
            );
            unprocessedJuniorShares = unprocessedJuniorShares.sub(paidJuniorAmount);
            unprocessedSeniorShares = unprocessedSeniorShares.sub(paidSeniorAmount);

            // Epoch 2
            shares = toToken(8524);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            paidJuniorAmount = unprocessedJuniorShares;
            paidSeniorAmount = unprocessedSeniorShares;
            await creditContract.makePayment(
                ethers.constants.HashZero,
                paidJuniorAmount.add(paidSeniorAmount),
            );
            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(
                BN.from(0),
                seniorTotalAssets,
                juniorTotalAssets.sub(paidJuniorAmount),
            );

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(paidJuniorAmount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            unprocessedJuniorShares = unprocessedJuniorShares.sub(paidJuniorAmount);
            unprocessedSeniorShares = unprocessedSeniorShares.sub(paidSeniorAmount);

            // Epoch 3
            shares = toToken(1837);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(268);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            unprocessed = unprocessedJuniorShares.add(unprocessedSeniorShares);
            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(unprocessed, seniorTotalAssets, juniorTotalAssets);

            // Epoch 4
            shares = toToken(4697);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(736);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            unprocessed = unprocessedJuniorShares.add(unprocessedSeniorShares);

            paidSeniorAmount = unprocessedSeniorShares;
            paidJuniorAmount = toToken(195);
            allPaid = paidJuniorAmount.add(paidSeniorAmount);
            await creditContract.makePayment(ethers.constants.HashZero, allPaid);
            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            await testCloseEpoch(
                unprocessed.sub(allPaid),
                seniorTotalAssets.sub(paidSeniorAmount),
                juniorTotalAssets.sub(paidJuniorAmount),
            );

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(paidJuniorAmount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(paidSeniorAmount),
            );
        });
    });

    describe("Flex Call Tests", function () {
        async function prepareForFlexCall() {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 3);
        }

        beforeEach(async function () {
            await loadFixture(prepareForFlexCall);
        });

        it("Should close an epoch successfully after processing one immature senior redemption request fully", async function () {
            const settings = await poolConfigContract.getPoolSettings();

            let shares = toToken(5283);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(shares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(shares),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close an epoch successfully while processing multiple immature senior redemption requests fully", async function () {
            const settings = await poolConfigContract.getPoolSettings();

            // Epoch 1

            let shares = toToken(5263);
            let allShares = shares;
            await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

            // Move all assets out of pool safe

            let availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            // Epoch 2

            shares = toToken(8463);
            allShares = allShares.add(shares);
            await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.constants.HashZero, allShares);

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(allShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(allShares),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epoch successfully after processing multiple immature senior redemption requests (\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 5);

            const settings = await poolConfigContract.getPoolSettings();

            // Epoch 1

            let shares = toToken(237);
            let partialPaymentAmount = shares;
            let allShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool safe

            let availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            // Epoch 2

            shares = toToken(963);
            allShares = allShares.add(shares);
            partialPaymentAmount = partialPaymentAmount.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            // Epoch 3

            shares = toToken(463);
            partialPaymentAmount = partialPaymentAmount.add(toToken(169));
            allShares = allShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch 3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            // Epoch 4

            shares = toToken(728);
            allShares = allShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.constants.HashZero, partialPaymentAmount);

            // Close epoch 4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(partialPaymentAmount),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares.sub(partialPaymentAmount),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(partialPaymentAmount),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epoch successfully after processing one immature junior redemption request fully", async function () {
            const settings = await poolConfigContract.getPoolSettings();

            let shares = toToken(5283);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(shares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(shares),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epoch successfully after processing multiple immature junior redemption requests fully", async function () {
            const settings = await poolConfigContract.getPoolSettings();

            // Epoch 1

            let shares = toToken(748);
            let allShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool safe

            let availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);

            // Epoch 2

            shares = toToken(253);
            allShares = allShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);

            // Epoch 3

            shares = toToken(3849);
            allShares = allShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.constants.HashZero, allShares);

            // Close epoch 3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(allShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(allShares),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epoch successfully after processing multiple immature junior redemption requests (\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 5);

            const settings = await poolConfigContract.getPoolSettings();

            // Epoch 1

            let shares = toToken(2363);
            let partialPaymentAmount = shares;
            let allShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool safe

            let availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            // Epoch 2

            shares = toToken(6478);
            allShares = allShares.add(shares);
            partialPaymentAmount = partialPaymentAmount.add(toToken(2637));
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            // Epoch 3

            shares = toToken(7354);
            allShares = allShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch 3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            // Epoch 4

            shares = toToken(1349);
            allShares = allShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.constants.HashZero, partialPaymentAmount);

            // Close epoch 4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(partialPaymentAmount),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares.sub(partialPaymentAmount),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(partialPaymentAmount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epoch successfully after processing one mature senior redemption request, one mature junior redemption request, \
        one immature senior redemption request and one immature junior redemption request fully", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 1);

            const settings = await poolConfigContract.getPoolSettings();

            // Epoch 1

            let shares = toToken(3643);
            let unprocessedJuniorShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(1526);
            let unprocessedSeniorShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let unprocessed = unprocessedJuniorShares.add(unprocessedSeniorShares);

            // Move all assets out of pool safe

            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessed,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch 2

            shares = toToken(5625);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(763);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            unprocessed = unprocessedJuniorShares.add(unprocessedSeniorShares);

            await creditContract.makePayment(ethers.constants.HashZero, unprocessed);

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
            // console.log(`seniorTotalAssets: ${seniorTotalAssets}, unprocessedSeniorShares: ${unprocessedSeniorShares}`);
            // console.log(`juniorTotalAssets: ${juniorTotalAssets}, unprocessedJuniorShares: ${unprocessedJuniorShares}`);
            // console.log(`unprocessed: ${unprocessed}`);

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(unprocessedSeniorShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(unprocessedJuniorShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(unprocessedJuniorShares),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedSeniorShares),
            );
        });

        it("Should close epoch successfully after processing multiple redemption requests, \
        multiple mature senior redemption requests are processed fully, \
        multiple mature junior redemption requests are processed fully, \
        multiple immature senior redemption requests are processed fully, \
        multiple immature junior redemption requests are processed fully", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 2);

            const settings = await poolConfigContract.getPoolSettings();

            // Epoch 1

            let shares = toToken(3643);
            let unprocessedJuniorShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(1526);
            let unprocessedSeniorShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool safe

            let paidSeniorAmount = toToken(242);
            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(
                ethers.constants.HashZero,
                totalAssets.sub(paidSeniorAmount),
            );

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(paidSeniorAmount),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedSeniorShares.add(unprocessedJuniorShares).sub(paidSeniorAmount),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);
            unprocessedSeniorShares = unprocessedSeniorShares.sub(paidSeniorAmount);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(paidSeniorAmount),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch 2

            shares = toToken(9483);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(456);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares.add(unprocessedSeniorShares),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch 3

            shares = toToken(3458);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(1283);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch 3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares.add(unprocessedSeniorShares),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch 4

            shares = toToken(2958);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(647);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(
                ethers.constants.HashZero,
                unprocessedJuniorShares.add(unprocessedSeniorShares),
            );

            // Close epoch 4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(unprocessedSeniorShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(unprocessedJuniorShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(4);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(4);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(unprocessedJuniorShares),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedSeniorShares),
            );
        });

        it("Should close epoch successfully after processing multiple redemption requests, \
        multiple mature senior redemption requests are processed fully, \
        multiple mature junior redemption requests are processed partially (\
        some are processed fully, some are processed partially and some are unprocessed), \
        multiple immature senior redemption requests are processed partially (\
        some are processed fully, some are processed partially and some are unprocessed), \
        multiple immature junior redemption requests are unprocessed", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 2);

            const settings = await poolConfigContract.getPoolSettings();
            const lpConfig = await poolConfigContract.getLPConfig();

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            const availableSeniorAmount = juniorTotalAssets
                .mul(lpConfig.maxSeniorJuniorRatio)
                .sub(seniorTotalAssets);
            // console.log(
            //     `availableSeniorAmount: ${availableSeniorAmount}, lpConfig.maxSeniorJuniorRatio: ${lpConfig.maxSeniorJuniorRatio}, seniorTotalAssets: ${seniorTotalAssets}, juniorTotalAssets: ${juniorTotalAssets}`
            // );
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(availableSeniorAmount, lender.address);

            // Epoch 1

            let shares = toToken(118473);
            let unprocessedJuniorShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(359263);
            let unprocessedSeniorShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool safe

            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedSeniorShares.add(unprocessedJuniorShares),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch 2

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares.add(unprocessedSeniorShares),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch 3

            let processedJ = await getMaxJuniorProcessed(
                unprocessedSeniorShares,
                lpConfig.maxSeniorJuniorRatio,
            );
            shares = toToken(34582);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let processedS = unprocessedSeniorShares;
            shares = toToken(11283);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let paidSeniorAmount = toToken(9478);

            await creditContract.makePayment(
                ethers.constants.HashZero,
                processedJ.add(processedS).add(paidSeniorAmount),
            );

            // Close epoch 3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(processedS).sub(paidSeniorAmount),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(processedJ),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares
                        .add(unprocessedSeniorShares)
                        .sub(processedJ.add(processedS).add(paidSeniorAmount)),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(processedJ),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(processedS).sub(paidSeniorAmount),
            );
            unprocessedJuniorShares = unprocessedJuniorShares.sub(processedJ);
            unprocessedSeniorShares = unprocessedSeniorShares
                .sub(processedS)
                .sub(paidSeniorAmount);

            // Epoch 4

            processedJ = await getMaxJuniorProcessed(0, lpConfig.maxSeniorJuniorRatio);
            shares = toToken(6283);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(4633);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            paidSeniorAmount = toToken(723);
            await creditContract.makePayment(
                ethers.constants.HashZero,
                processedJ.add(paidSeniorAmount),
            );

            // Close epoch 4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(paidSeniorAmount),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(processedJ),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares
                        .add(unprocessedSeniorShares)
                        .sub(processedJ.add(paidSeniorAmount)),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(processedJ),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(paidSeniorAmount),
            );
        });

        it("Should close epoch successfully after processing multiple redemption requests, \
        multiple mature senior redemption requests are processed fully, \
        multiple mature junior redemption requests are processed fully, \
        multiple immature senior redemption requests are processed fully, \
        multiple immature junior redemption requests are processed partially (\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 2);

            const settings = await poolConfigContract.getPoolSettings();
            let lpConfig = await poolConfigContract.getLPConfig();

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            let availableSeniorAmount = juniorTotalAssets
                .mul(lpConfig.maxSeniorJuniorRatio)
                .sub(seniorTotalAssets);
            // console.log(
            //     `availableSeniorAmount: ${availableSeniorAmount}, lpConfig.maxSeniorJuniorRatio: ${lpConfig.maxSeniorJuniorRatio}, seniorTotalAssets: ${seniorTotalAssets}, juniorTotalAssets: ${juniorTotalAssets}`
            // );
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(availableSeniorAmount, lender.address);

            // Epoch 1

            let shares = toToken(121383);
            let unprocessedJuniorShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(463738);
            let unprocessedSeniorShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool safe

            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedSeniorShares.add(unprocessedJuniorShares),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch 2

            let paidSeniorAmount = toToken(13645);
            await creditContract.makePayment(ethers.constants.HashZero, paidSeniorAmount);

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(paidSeniorAmount),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares.add(unprocessedSeniorShares).sub(paidSeniorAmount),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(paidSeniorAmount),
            );
            unprocessedSeniorShares = unprocessedSeniorShares.sub(paidSeniorAmount);

            // Epoch 3

            let processedJ = unprocessedJuniorShares;
            shares = toToken(3748);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(105965);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let paidJuniorAmount = toToken(647);

            await creditContract.makePayment(
                ethers.constants.HashZero,
                processedJ.add(unprocessedSeniorShares).add(paidJuniorAmount),
            );

            // Close epoch 3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(unprocessedSeniorShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(processedJ).sub(paidJuniorAmount),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares.sub(processedJ).sub(paidJuniorAmount),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(processedJ).sub(paidJuniorAmount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedSeniorShares),
            );
            unprocessedJuniorShares = unprocessedJuniorShares
                .sub(processedJ)
                .sub(paidJuniorAmount);
            unprocessedSeniorShares = toToken(0);

            // Epoch 4

            shares = toToken(5345);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(57483);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            paidJuniorAmount = toToken(3343);
            await creditContract.makePayment(
                ethers.constants.HashZero,
                unprocessedSeniorShares.add(paidJuniorAmount),
            );

            // Close epoch 4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(unprocessedSeniorShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(paidJuniorAmount),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares.sub(paidJuniorAmount),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(paidJuniorAmount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedSeniorShares),
            );
        });

        it("Should reserve balance in pool safe after mature junior redemption requests are processed partially because of maxSeniorJuniorRatio", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 1);

            const settings = await poolConfigContract.getPoolSettings();
            let lpConfig = await poolConfigContract.getLPConfig();

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            let availableSeniorAmount = juniorTotalAssets
                .mul(lpConfig.maxSeniorJuniorRatio)
                .sub(seniorTotalAssets);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(availableSeniorAmount, lender.address);

            // Epoch 1

            let shares = toToken(73645);
            let unprocessedJuniorShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(164738);
            let unprocessedSeniorShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool safe

            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

            // Close epoch 1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedSeniorShares.add(unprocessedJuniorShares),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch 2

            shares = toToken(27468);
            unprocessedJuniorShares = unprocessedJuniorShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let processedS = unprocessedSeniorShares;
            shares = toToken(3647);
            unprocessedSeniorShares = unprocessedSeniorShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let processedJ = await getMaxJuniorProcessed(
                unprocessedSeniorShares,
                lpConfig.maxSeniorJuniorRatio,
            );
            let leftAssets = toToken(36485);
            await creditContract.makePayment(
                ethers.constants.HashZero,
                unprocessedSeniorShares.add(processedJ).add(leftAssets),
            );

            // Close Epoch 2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime.toNumber(),
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(unprocessedSeniorShares),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(processedJ),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJuniorShares.sub(processedJ),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(processedJ),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedSeniorShares),
            );

            expect(await poolSafeContract.getAvailableLiquidity()).to.equal(0);
            expect(await poolSafeContract.getAvailableReservation()).to.equal(leftAssets);
        });
    });
});
