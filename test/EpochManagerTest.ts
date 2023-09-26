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
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    FirstLossCover,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
    ProfitEscrow,
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
    platformFeeManagerContract: PlatformFeeManager,
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
    creditContract: CreditLine,
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
            platformFeeManagerContract,
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

    it("Should start new epoch", async function () {
        let settings = await poolConfigContract.getPoolSettings();

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

    it("Should not close epoch while protocol is paused or pool is not on", async function () {
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

    it("Should not close epoch before end time", async function () {
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            epochManagerContract,
            "closeTooSoon",
        );
    });

    it("Should close epoch successfully while processing one senior fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        let withdrawalShares = toToken(2539);
        await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(withdrawalShares);

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
                seniorTotalAssets.sub(withdrawalShares),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets.sub(withdrawalShares),
        );
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
    });

    it("Should close epoch successfully while processing multiple senior fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(236);
        let allShares = shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolSafeContract.totalAssets();
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

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

        // Epoch2

        shares = toToken(1357);
        allShares = allShares.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        await creditContract.makePayment(ethers.constants.HashZero, allShares);

        // Close epoch2

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

    it("Should close epoch successfully while processing multiple senior epochs (\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(376);
        let partialPaid = shares;
        let allShares = shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolSafeContract.totalAssets();
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

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

        // Epoch2

        shares = toToken(865);
        allShares = allShares.add(shares);
        partialPaid = partialPaid.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch2

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

        // Epoch3

        shares = toToken(637);
        partialPaid = partialPaid.add(toToken(169));
        allShares = allShares.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch3

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

        // Epoch4

        shares = toToken(497);
        allShares = allShares.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        await creditContract.makePayment(ethers.constants.HashZero, partialPaid);

        // Close epoch4

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
                seniorTotalAssets.sub(partialPaid),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                allShares.sub(partialPaid),
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
        expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets.sub(partialPaid),
        );
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
    });

    it("Should close epoch successfully while processing one junior fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        let withdrawalShares = toToken(7363);
        await juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(withdrawalShares);

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
                juniorTotalAssets.sub(withdrawalShares),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(withdrawalShares),
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
    });

    it("Should close epoch successfully while processing multiple junior fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(396);
        let allShares = shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolSafeContract.totalAssets();
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

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

        // Epoch2

        shares = toToken(873);
        allShares = allShares.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch2

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

        // Epoch3

        shares = toToken(4865);
        allShares = allShares.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        await creditContract.makePayment(ethers.constants.HashZero, allShares);

        // Close epoch3

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

    it("Should close epoch successfully while processing multiple junior epochs (\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(1628);
        let partialPaid = shares;
        let allShares = shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolSafeContract.totalAssets();
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

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

        // Epoch2

        shares = toToken(3748);
        allShares = allShares.add(shares);
        partialPaid = partialPaid.add(toToken(2637));
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch2

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

        // Epoch3

        shares = toToken(8474);
        allShares = allShares.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch3

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

        // Epoch4

        shares = toToken(7463);
        allShares = allShares.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        await creditContract.makePayment(ethers.constants.HashZero, partialPaid);

        // Close epoch4

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
                juniorTotalAssets.sub(partialPaid),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                allShares.sub(partialPaid),
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
        expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(partialPaid),
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
    });

    it("Should close epoch successfully while processing one senior and one junior epoch fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        let withdrawalShares = toToken(1000);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(withdrawalShares);
        await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(withdrawalShares);

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
        let juniorBalance = await mockTokenContract.balanceOf(juniorTrancheVaultContract.address);

        let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        let seniorTotalSupply = await seniorTrancheVaultContract.totalSupply();
        let seniorBalance = await mockTokenContract.balanceOf(seniorTrancheVaultContract.address);

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
        checkEpochInfo(epoch, BN.from(1), withdrawalShares, withdrawalShares, withdrawalShares);
        epoch = await juniorTrancheVaultContract.epochInfoByEpochId(1);
        checkEpochInfo(epoch, BN.from(1), withdrawalShares, withdrawalShares, withdrawalShares);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);

        expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
        expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
    });

    it("Should close epoch successfully while processing multiple epochs, \
    multiple senior epochs are processed fully, \
    multiple junior epochs are processed fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(1628);
        let allSharesJ = shares;
        let allShares = shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(357);
        let allSharesS = shares;
        allShares = allShares.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolSafeContract.totalAssets();
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

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

        // Epoch2

        shares = toToken(3653);
        allShares = allShares.add(shares);
        allSharesJ = allSharesJ.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(2536);
        allShares = allShares.add(shares);
        allSharesS = allSharesS.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch2

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

        // Epoch3

        shares = toToken(9474);
        allShares = allShares.add(shares);
        allSharesJ = allSharesJ.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(736);
        allShares = allShares.add(shares);
        allSharesS = allSharesS.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch3

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

        // Epoch4

        await creditContract.makePayment(ethers.constants.HashZero, allShares);

        // Close epoch4

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
                seniorTotalAssets.sub(allSharesS),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                juniorTotalAssets.sub(allSharesJ),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(allSharesJ),
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets.sub(allSharesS),
        );
    });

    it("Should close epoch successfully while processing multiple epochs, \
    multiple senior epochs are processed fully, \
    multiple junior epochs are processed partially (\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(4637);
        let unprocessedJ = shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(1938);
        let unprocessedS = shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        let unprocessed = unprocessedJ.add(unprocessedS);

        // Move all assets out of pool vault

        let totalAssets = await poolSafeContract.totalAssets();
        let paidS = unprocessedS;
        let paidJ = toToken(1349);
        let allPaid = paidJ.add(paidS);
        await creditContract.drawdown(
            ethers.constants.HashZero,
            totalAssets.sub(paidJ.add(paidS)),
        );

        // Close epoch1

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
                seniorTotalAssets.sub(paidS),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                juniorTotalAssets.sub(paidJ),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                unprocessed.sub(allPaid),
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
        expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets.sub(paidS),
        );
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(paidJ),
        );
        unprocessedJ = unprocessedJ.sub(paidJ);
        unprocessedS = unprocessedS.sub(paidS);

        // Epoch2

        shares = toToken(8524);
        unprocessedJ = unprocessedJ.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        // shares = toToken(0);
        // unprocessedS = unprocessedS.add(shares);
        // await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        unprocessed = unprocessedJ.add(unprocessedS);

        paidJ = unprocessedJ;
        paidS = unprocessedS;
        await creditContract.makePayment(ethers.constants.HashZero, paidJ.add(paidS));

        // Close epoch2

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
                juniorTotalAssets.sub(paidJ),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(paidJ),
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        unprocessedJ = unprocessedJ.sub(paidJ);
        unprocessedS = unprocessedS.sub(paidS);
        unprocessed = unprocessedJ.add(unprocessedS);

        // Epoch3

        shares = toToken(1837);
        unprocessedJ = unprocessedJ.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(268);
        unprocessedS = unprocessedS.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        unprocessed = unprocessedJ.add(unprocessedS);

        // Close epoch3

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
                unprocessed,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        // Epoch4

        shares = toToken(4697);
        unprocessedJ = unprocessedJ.add(shares);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(736);
        unprocessedS = unprocessedS.add(shares);
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        unprocessed = unprocessedJ.add(unprocessedS);

        paidS = unprocessedS;
        paidJ = toToken(195);
        allPaid = paidJ.add(paidS);
        await creditContract.makePayment(ethers.constants.HashZero, allPaid);

        // Close epoch4

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
                seniorTotalAssets.sub(paidS),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                juniorTotalAssets.sub(paidJ),
                CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                unprocessed.sub(allPaid),
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
        expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(paidJ),
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets.sub(paidS),
        );
    });

    describe("Flex Call Tests", function () {
        async function prepareForFlexCall() {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 3);
        }

        beforeEach(async function () {
            await loadFixture(prepareForFlexCall);
        });

        it("Should close epoch successfully while processing one immature senior fully", async function () {
            let settings = await poolConfigContract.getPoolSettings();

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

        it("Should close epoch successfully while processing multiple immature senior fully", async function () {
            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(5263);
            let allShares = shares;
            await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Close epoch1

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

            // Epoch2

            shares = toToken(8463);
            allShares = allShares.add(shares);
            await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.constants.HashZero, allShares);

            // Close epoch2

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

        it("Should close epoch successfully while processing multiple immature senior (\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 5);

            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(237);
            let partialPaid = shares;
            let allShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Close epoch1

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

            // Epoch2

            shares = toToken(963);
            allShares = allShares.add(shares);
            partialPaid = partialPaid.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch2

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

            // Epoch3

            shares = toToken(463);
            partialPaid = partialPaid.add(toToken(169));
            allShares = allShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch3

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

            // Epoch4

            shares = toToken(728);
            allShares = allShares.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.constants.HashZero, partialPaid);

            // Close epoch4

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
                    seniorTotalAssets.sub(partialPaid),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares.sub(partialPaid),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(partialPaid),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epoch successfully while processing one immature junior fully", async function () {
            let settings = await poolConfigContract.getPoolSettings();

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

        it("Should close epoch successfully while processing multiple immature junior fully", async function () {
            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(748);
            let allShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Close epoch1

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

            // Epoch2

            shares = toToken(253);
            allShares = allShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch2

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

            // Epoch3

            shares = toToken(3849);
            allShares = allShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.constants.HashZero, allShares);

            // Close epoch3

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

        it("Should close epoch successfully while processing multiple immature junior (\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 5);

            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(2363);
            let partialPaid = shares;
            let allShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let availableAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

            // Close epoch1

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

            // Epoch2

            shares = toToken(6478);
            allShares = allShares.add(shares);
            partialPaid = partialPaid.add(toToken(2637));
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch2

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

            // Epoch3

            shares = toToken(7354);
            allShares = allShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch3

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

            // Epoch4

            shares = toToken(1349);
            allShares = allShares.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.constants.HashZero, partialPaid);

            // Close epoch4

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
                    juniorTotalAssets.sub(partialPaid),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    allShares.sub(partialPaid),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(partialPaid),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epoch successfully while processing one mature senior, one mature junior, \
        one immature senior and one immature junior fully", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 1);

            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(3643);
            let unprocessedJ = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(1526);
            let unprocessedS = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let unprocessed = unprocessedJ.add(unprocessedS);

            // Move all assets out of pool vault

            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

            // Close epoch1

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

            // Epoch2

            shares = toToken(5625);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(763);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            unprocessed = unprocessedJ.add(unprocessedS);

            await creditContract.makePayment(ethers.constants.HashZero, unprocessed);

            // Close epoch2

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
            // console.log(`seniorTotalAssets: ${seniorTotalAssets}, unprocessedS: ${unprocessedS}`);
            // console.log(`juniorTotalAssets: ${juniorTotalAssets}, unprocessedJ: ${unprocessedJ}`);
            // console.log(`unprocessed: ${unprocessed}`);

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets.sub(unprocessedS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(unprocessedJ),
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
                juniorTotalAssets.sub(unprocessedJ),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedS),
            );
        });

        it("Should close epoch successfully while processing multiple epochs, \
        multiple mature senior epochs are processed fully, \
        multiple mature junior epochs are processed fully, \
        multiple immature senior epochs are processed fully, \
        multiple immature junior epochs are processed fully", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 2);

            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(3643);
            let unprocessedJ = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(1526);
            let unprocessedS = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let paidS = toToken(242);
            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets.sub(paidS));

            // Close epoch1

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
                    seniorTotalAssets.sub(paidS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedS.add(unprocessedJ).sub(paidS),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);
            unprocessedS = unprocessedS.sub(paidS);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(paidS),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            shares = toToken(9483);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(456);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch2

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
                    unprocessedJ.add(unprocessedS),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch3

            shares = toToken(3458);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(1283);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch3

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
                    unprocessedJ.add(unprocessedS),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch4

            shares = toToken(2958);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(647);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(
                ethers.constants.HashZero,
                unprocessedJ.add(unprocessedS),
            );

            // Close epoch4

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
                    seniorTotalAssets.sub(unprocessedS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(unprocessedJ),
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
                juniorTotalAssets.sub(unprocessedJ),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedS),
            );
        });

        it("Should close epoch successfully while processing multiple epochs, \
        multiple mature senior epochs are processed fully, \
        multiple mature junior epochs are processed partially (\
        some are processed fully, some are processed partially and some are unprocessed), \
        multiple immature senior epochs are processed partially (\
        some are processed fully, some are processed partially and some are unprocessed), \
        multiple immature junior epochs are unprocessed", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 2);

            let settings = await poolConfigContract.getPoolSettings();
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

            // Epoch1

            let shares = toToken(118473);
            let unprocessedJ = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(359263);
            let unprocessedS = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

            // Close epoch1

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
                    unprocessedS.add(unprocessedJ),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            // Close epoch2

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
                    unprocessedJ.add(unprocessedS),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch3

            let processedJ = await getMaxJuniorProcessed(
                unprocessedS,
                lpConfig.maxSeniorJuniorRatio,
            );
            shares = toToken(34582);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let processedS = unprocessedS;
            shares = toToken(11283);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let paidS = toToken(9478);

            await creditContract.makePayment(
                ethers.constants.HashZero,
                processedJ.add(processedS).add(paidS),
            );

            // Close epoch3

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
                    seniorTotalAssets.sub(processedS).sub(paidS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(processedJ),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJ.add(unprocessedS).sub(processedJ.add(processedS).add(paidS)),
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
                seniorTotalAssets.sub(processedS).sub(paidS),
            );
            unprocessedJ = unprocessedJ.sub(processedJ);
            unprocessedS = unprocessedS.sub(processedS).sub(paidS);

            // Epoch4

            processedJ = await getMaxJuniorProcessed(0, lpConfig.maxSeniorJuniorRatio);
            shares = toToken(6283);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(4633);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            paidS = toToken(723);
            await creditContract.makePayment(ethers.constants.HashZero, processedJ.add(paidS));

            // Close epoch4

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
                    seniorTotalAssets.sub(paidS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(processedJ),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJ.add(unprocessedS).sub(processedJ.add(paidS)),
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
                seniorTotalAssets.sub(paidS),
            );
        });

        it("Should close epoch successfully while processing multiple epochs, \
        multiple mature senior epochs are processed fully, \
        multiple mature junior epochs are processed fully, \
        multiple immature senior epochs are processed fully, \
        multiple immature junior epochs are processed partially (\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 2);

            let settings = await poolConfigContract.getPoolSettings();
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

            // Epoch1

            let shares = toToken(121383);
            let unprocessedJ = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(463738);
            let unprocessedS = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

            // Close epoch1

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
                    unprocessedS.add(unprocessedJ),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            let paidS = toToken(13645);
            await creditContract.makePayment(ethers.constants.HashZero, paidS);

            // Close epoch2

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
                    seniorTotalAssets.sub(paidS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJ.add(unprocessedS).sub(paidS),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(paidS),
            );
            unprocessedS = unprocessedS.sub(paidS);

            // Epoch3

            let processedJ = unprocessedJ;
            shares = toToken(3748);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(105965);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let paidJ = toToken(647);

            await creditContract.makePayment(
                ethers.constants.HashZero,
                processedJ.add(unprocessedS).add(paidJ),
            );

            // Close epoch3

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
                    seniorTotalAssets.sub(unprocessedS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(processedJ).sub(paidJ),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJ.sub(processedJ).sub(paidJ),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(1);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(processedJ).sub(paidJ),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedS),
            );
            unprocessedJ = unprocessedJ.sub(processedJ).sub(paidJ);
            unprocessedS = toToken(0);

            // Epoch4

            shares = toToken(5345);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(57483);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            paidJ = toToken(3343);
            await creditContract.makePayment(ethers.constants.HashZero, unprocessedS.add(paidJ));

            // Close epoch4

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
                    seniorTotalAssets.sub(unprocessedS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(paidJ),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJ.sub(paidJ),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(2);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(3);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets.sub(paidJ),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets.sub(unprocessedS),
            );
        });

        it("Should reserve balance in pool vault while mature junior epochs are processed partially because of maxSeniorJuniorRatio", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 1);

            let settings = await poolConfigContract.getPoolSettings();
            let lpConfig = await poolConfigContract.getLPConfig();

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            let availableSeniorAmount = juniorTotalAssets
                .mul(lpConfig.maxSeniorJuniorRatio)
                .sub(seniorTotalAssets);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(availableSeniorAmount, lender.address);

            // Epoch1

            let shares = toToken(73645);
            let unprocessedJ = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(164738);
            let unprocessedS = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let totalAssets = await poolSafeContract.totalAssets();
            await creditContract.drawdown(ethers.constants.HashZero, totalAssets);

            // Close epoch1

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
                    unprocessedS.add(unprocessedJ),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(lastEpoch.id.toNumber() + 1, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.firstUnprocessedEpochIndex()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            shares = toToken(27468);
            unprocessedJ = unprocessedJ.add(shares);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let processedS = unprocessedS;
            shares = toToken(3647);
            unprocessedS = unprocessedS.add(shares);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let processedJ = await getMaxJuniorProcessed(
                unprocessedS,
                lpConfig.maxSeniorJuniorRatio,
            );
            let leftAssets = toToken(36485);
            await creditContract.makePayment(
                ethers.constants.HashZero,
                unprocessedS.add(processedJ).add(leftAssets),
            );

            // Close epoch2

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
                    seniorTotalAssets.sub(unprocessedS),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    juniorTotalAssets.sub(processedJ),
                    CONSTANTS.DEFAULT_DECIMALS_FACTOR,
                    unprocessedJ.sub(processedJ),
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
                seniorTotalAssets.sub(unprocessedS),
            );

            expect(await poolSafeContract.getAvailableLiquidity()).to.equal(0);
            expect(await poolSafeContract.getAvailableReservation()).to.equal(leftAssets);
        });
    });
});
