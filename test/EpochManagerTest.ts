import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
    checkEpochInfo,
    CONSTANTS,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    getNextDueDate,
} from "./BaseTest";
import { mineNextBlockWithTimestamp, setNextBlockTimestamp, toToken } from "./TestUtils";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
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
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";

let defaultDeployer: HardhatEthersSigner,
    protocolOwner: HardhatEthersSigner,
    treasury: HardhatEthersSigner,
    eaServiceAccount: HardhatEthersSigner,
    pdsServiceAccount: HardhatEthersSigner;
let poolOwner: HardhatEthersSigner,
    poolOwnerTreasury: HardhatEthersSigner,
    evaluationAgent: HardhatEthersSigner,
    poolOperator: HardhatEthersSigner;
let lender: HardhatEthersSigner, lender2: HardhatEthersSigner;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    poolOwnerAndEAFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

async function getMinJuniorAssets(
    seniorMatureRedemptionInThisEpoch: bigint,
    maxSeniorJuniorRatio: bigint,
) {
    let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
    seniorTotalAssets = seniorTotalAssets - seniorMatureRedemptionInThisEpoch;
    let minJuniorAssets = seniorTotalAssets / maxSeniorJuniorRatio;
    if (minJuniorAssets * maxSeniorJuniorRatio < seniorTotalAssets) {
        minJuniorAssets = minJuniorAssets + 1n;
    }
    return minJuniorAssets;
}

async function getMaxJuniorProcessed(
    seniorMatureRedemptionInThisEpoch: bigint,
    maxSeniorJuniorRatio: bigint,
) {
    let minJuniorAssets = await getMinJuniorAssets(
        seniorMatureRedemptionInThisEpoch,
        maxSeniorJuniorRatio,
    );
    let juniorAssets = await juniorTrancheVaultContract.totalAssets();
    return juniorAssets - minJuniorAssets;
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
            poolVaultContract,
            calendarContract,
            poolOwnerAndEAFirstLossCoverContract,
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
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Goes forward one day and start a new epoch
        let ts = endTime + 60 * 5;
        await mineNextBlockWithTimestamp(ts);
        lastEpoch = await epochManagerContract.currentEpoch();
        [endTime] = getNextDueDate(settings.calendarUnit, 0, ts, settings.payPeriodInCalendarUnit);
        await expect(poolContract.connect(poolOwner).enablePool())
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);
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
        const settings = await poolConfigContract.getPoolSettings();

        const withdrawalShares = toToken(2539);
        await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(withdrawalShares);

        const lastEpoch = await epochManagerContract.currentEpoch();
        const ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
            ts,
            settings.payPeriodInCalendarUnit,
        );

        const seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        const juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets - withdrawalShares,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets - withdrawalShares,
        );
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
    });

    it("Should close epoch successfully while processing multi senior fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(236);
        let allShares = shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolVaultContract.totalAssets();
        await creditContract.drawdown(ethers.ZeroHash, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch2

        shares = toToken(1357);
        allShares = allShares + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        await creditContract.makePayment(ethers.ZeroHash, allShares);

        // Close epoch2
        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
            ts,
            settings.payPeriodInCalendarUnit,
        );

        seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets - allShares,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets - allShares,
        );
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
    });

    it("Should close epoch successfully while processing multi senior epochs(\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(376);
        let partialPaid = shares;
        let allShares = shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolVaultContract.totalAssets();
        await creditContract.drawdown(ethers.ZeroHash, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch2

        shares = toToken(865);
        allShares = allShares + shares;
        partialPaid = partialPaid + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch2

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch3

        shares = toToken(637);
        partialPaid = partialPaid + toToken(169);
        allShares = allShares + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch3

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch4

        shares = toToken(497);
        allShares = allShares + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        await creditContract.makePayment(ethers.ZeroHash, partialPaid);

        // Close epoch4

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
            ts,
            settings.payPeriodInCalendarUnit,
        );

        seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets - partialPaid,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares - partialPaid,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
        expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets - partialPaid,
        );
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
    });

    it("Should close epoch successfully while processing one junior fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        let withdrawalShares = toToken(7363);
        await juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(withdrawalShares);

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets - withdrawalShares,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets - withdrawalShares,
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
    });

    it("Should close epoch successfully while processing multi junior fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(396);
        let allShares = shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolVaultContract.totalAssets();
        await creditContract.drawdown(ethers.ZeroHash, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);
        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);

        // Epoch2

        shares = toToken(873);
        allShares = allShares + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch2

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);
        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);

        // Epoch3

        shares = toToken(4865);
        allShares = allShares + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        await creditContract.makePayment(ethers.ZeroHash, allShares);

        // Close epoch3

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets - allShares,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets - allShares,
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
    });

    it("Should close epoch successfully while processing multi junior epochs(\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(1628);
        let partialPaid = shares;
        let allShares = shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolVaultContract.totalAssets();
        await creditContract.drawdown(ethers.ZeroHash, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch2

        shares = toToken(3748);
        allShares = allShares + shares;
        partialPaid = partialPaid + toToken(2637);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch2

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch3

        shares = toToken(8474);
        allShares = allShares + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch3

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch4

        shares = toToken(7463);
        allShares = allShares + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        await creditContract.makePayment(ethers.ZeroHash, partialPaid);

        // Close epoch4

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets - partialPaid,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares - partialPaid,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
        expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets - partialPaid,
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
    });

    it("Should close epoch successfully while processing one senior and one junior epoch fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        let withdrawalShares = toToken(1000);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(withdrawalShares);
        await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(withdrawalShares);

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime + 60n * 5n;
        await mineNextBlockWithTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
            ts,
            settings.payPeriodInCalendarUnit,
        );

        let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
        let juniorTotalSupply = await juniorTrancheVaultContract.totalSupply();
        let juniorBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.getAddress(),
        );

        let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        let seniorTotalSupply = await seniorTrancheVaultContract.totalSupply();
        let seniorBalance = await mockTokenContract.balanceOf(
            seniorTrancheVaultContract.getAddress(),
        );

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets - withdrawalShares,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets - withdrawalShares,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime)
            .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
            .withArgs(1, withdrawalShares, withdrawalShares, 1)
            .to.emit(juniorTrancheVaultContract, "EpochsProcessed")
            .withArgs(1, withdrawalShares, withdrawalShares, 1);

        expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
            juniorTotalSupply - withdrawalShares,
        );
        expect(
            await mockTokenContract.balanceOf(juniorTrancheVaultContract.getAddress()),
        ).to.equal(juniorBalance + withdrawalShares);
        expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
            seniorTotalSupply - withdrawalShares,
        );
        expect(
            await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
        ).to.equal(seniorBalance + withdrawalShares);

        let epoch = await seniorTrancheVaultContract.epochMap(1);
        checkEpochInfo(epoch, 1n, withdrawalShares, withdrawalShares, withdrawalShares);
        epoch = await juniorTrancheVaultContract.epochMap(1);
        checkEpochInfo(epoch, 1n, withdrawalShares, withdrawalShares, withdrawalShares);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);

        expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
        expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
    });

    it("Should close epoch successfully while processing multi epochs, \
    multi senior epochs are processed fully, \
    multi junior epochs are processed fully", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(1628);
        let allSharesJ = shares;
        let allShares = shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(357);
        let allSharesS = shares;
        allShares = allShares + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Move all assets out of pool vault

        let availableAssets = await poolVaultContract.totalAssets();
        await creditContract.drawdown(ethers.ZeroHash, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch2

        shares = toToken(3653);
        allShares = allShares + shares;
        allSharesJ = allSharesJ + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(2536);
        allShares = allShares + shares;
        allSharesS = allSharesS + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch2

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch3

        shares = toToken(9474);
        allShares = allShares + shares;
        allSharesJ = allSharesJ + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(736);
        allShares = allShares + shares;
        allSharesS = allSharesS + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        // Close epoch3

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch4

        await creditContract.makePayment(ethers.ZeroHash, allShares);

        // Close epoch4

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
            ts,
            settings.payPeriodInCalendarUnit,
        );

        seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets - allSharesS,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets - allSharesJ,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(3);
        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(3);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets - allSharesJ,
        );
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets - allSharesS,
        );
    });

    it("Should close epoch successfully while processing multi epochs, \
    multi senior epochs are processed fully, \
    multi junior epochs are processed partially(\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {
        let settings = await poolConfigContract.getPoolSettings();

        // Epoch1

        let shares = toToken(4637);
        let unprocessedJ = shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(1938);
        let unprocessedS = shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        let unprocessed = unprocessedJ + unprocessedS;

        // Move all assets out of pool vault

        let totalAssets = await poolVaultContract.totalAssets();
        let paidS = unprocessedS;
        let paidJ = toToken(1349);
        let allPaid = paidJ + paidS;
        await creditContract.drawdown(ethers.ZeroHash, totalAssets - (paidJ + paidS));

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
            ts,
            settings.payPeriodInCalendarUnit,
        );

        let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets - paidS,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets - paidJ,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                unprocessed - allPaid,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
        expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets - paidS);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets - paidJ);
        unprocessedJ = unprocessedJ - paidJ;
        unprocessedS = unprocessedS - paidS;

        // Epoch2

        shares = toToken(8524);
        unprocessedJ = unprocessedJ + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

        paidJ = unprocessedJ;
        paidS = unprocessedS;
        await creditContract.makePayment(ethers.ZeroHash, paidJ + paidS);

        // Close epoch2

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets - paidJ,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets - paidJ);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        unprocessedJ = unprocessedJ - paidJ;
        unprocessedS = unprocessedS - paidS;

        // Epoch3

        shares = toToken(1837);
        unprocessedJ = unprocessedJ + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(268);
        unprocessedS = unprocessedS + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        unprocessed = unprocessedJ + unprocessedS;

        // Close epoch3

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                unprocessed,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        // Epoch4

        shares = toToken(4697);
        unprocessedJ = unprocessedJ + shares;
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        shares = toToken(736);
        unprocessedS = unprocessedS + shares;
        await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        unprocessed = unprocessedJ + unprocessedS;

        paidS = unprocessedS;
        paidJ = toToken(195);
        allPaid = paidJ + paidS;
        await creditContract.makePayment(ethers.ZeroHash, allPaid);

        // Close epoch4

        lastEpoch = await epochManagerContract.currentEpoch();
        ts = lastEpoch.endTime + 60n * 5n;
        await setNextBlockTimestamp(ts);
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime,
            ts,
            settings.payPeriodInCalendarUnit,
        );

        seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets - paidS,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets - paidJ,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                unprocessed - allPaid,
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
        expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(3);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets - paidJ);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets - paidS);
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
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - shares,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - shares,
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epoch successfully while processing multi immature senior fully", async function () {
            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(5263);
            let allShares = shares;
            await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let availableAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, availableAssets);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            // Epoch2

            shares = toToken(8463);
            allShares = allShares + shares;
            await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.ZeroHash, allShares);

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - allShares,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - allShares,
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epoch successfully while processing multi immature senior(\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 5);

            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(237);
            let partialPaid = shares;
            let allShares = shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let availableAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, availableAssets);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            // Epoch2

            shares = toToken(963);
            allShares = allShares + shares;
            partialPaid = partialPaid + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            // Epoch3

            shares = toToken(463);
            partialPaid = partialPaid + toToken(169);
            allShares = allShares + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            // Epoch4

            shares = toToken(728);
            allShares = allShares + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.ZeroHash, partialPaid);

            // Close epoch4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - partialPaid,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares - partialPaid,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - partialPaid,
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
        });

        it("Should close epoch successfully while processing one immature junior fully", async function () {
            let settings = await poolConfigContract.getPoolSettings();

            let shares = toToken(5283);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - shares,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - shares,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epoch successfully while processing multi immature junior fully", async function () {
            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(748);
            let allShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let availableAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, availableAssets);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);

            // Epoch2

            shares = toToken(253);
            allShares = allShares + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);

            // Epoch3

            shares = toToken(3849);
            allShares = allShares + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.ZeroHash, allShares);

            // Close epoch3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - allShares,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - allShares,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
        });

        it("Should close epoch successfully while processing multi immature junior(\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 5);

            let settings = await poolConfigContract.getPoolSettings();

            // Epoch1

            let shares = toToken(2363);
            let partialPaid = shares;
            let allShares = shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Move all assets out of pool vault

            let availableAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, availableAssets);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            // Epoch2

            shares = toToken(6478);
            allShares = allShares + shares;
            partialPaid = partialPaid + toToken(2637);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            // Epoch3

            shares = toToken(7354);
            allShares = allShares + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            // Epoch4

            shares = toToken(1349);
            allShares = allShares + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.ZeroHash, partialPaid);

            // Close epoch4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - partialPaid,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    allShares - partialPaid,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - partialPaid,
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
            let unprocessed = unprocessedJ + unprocessedS;

            // Move all assets out of pool vault

            let totalAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, totalAssets);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessed,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            shares = toToken(5625);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(763);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            unprocessed = unprocessedJ + unprocessedS;

            await creditContract.makePayment(ethers.ZeroHash, unprocessed);

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    seniorTotalAssets - unprocessedS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - unprocessedJ,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - unprocessedJ,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - unprocessedS,
            );
        });

        it("Should close epoch successfully while processing multi epochs, \
        multi mature senior epochs are processed fully, \
        multi mature junior epochs are processed fully, \
        multi immature senior epochs are processed fully, \
        multi immature junior epochs are processed fully", async function () {
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
            let totalAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, totalAssets - paidS);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - paidS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedS + unprocessedJ - paidS,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);
            unprocessedS = unprocessedS - paidS;

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - paidS,
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            shares = toToken(9483);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(456);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ + unprocessedS,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch3

            shares = toToken(3458);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(1283);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            // Close epoch3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ + unprocessedS,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch4

            shares = toToken(2958);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(647);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            await creditContract.makePayment(ethers.ZeroHash, unprocessedJ + unprocessedS);

            // Close epoch4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - unprocessedS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - unprocessedJ,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    0,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(4);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(4);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - unprocessedJ,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - unprocessedS,
            );
        });

        it("Should close epoch successfully while processing multi epochs, \
        multi mature senior epochs are processed fully, \
        multi mature junior epochs are processed partially(\
        some are processed fully, some are processed partially and some are unprocessed), \
        multi immature senior epochs are processed partially(\
        some are processed fully, some are processed partially and some are unprocessed), \
        multi immature junior epochs are unprocessed", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 2);

            let settings = await poolConfigContract.getPoolSettings();
            let lpConfig = await poolConfigContract.getLPConfig();

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            let availableSeniorAmount =
                juniorTotalAssets * lpConfig.maxSeniorJuniorRatio - seniorTotalAssets;
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

            let totalAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, totalAssets);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedS + unprocessedJ,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ + unprocessedS,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);

            // Epoch3

            let processedJ = await getMaxJuniorProcessed(
                unprocessedS,
                lpConfig.maxSeniorJuniorRatio,
            );
            shares = toToken(34582);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let processedS = unprocessedS;
            shares = toToken(11283);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let paidS = toToken(9478);

            await creditContract.makePayment(ethers.ZeroHash, processedJ + processedS + paidS);

            // Close epoch3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - processedS - paidS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - processedJ,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ + unprocessedS - (processedJ + processedS + paidS),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - processedJ,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - processedS - paidS,
            );
            unprocessedJ = unprocessedJ - processedJ;
            unprocessedS = unprocessedS - processedS - paidS;

            // Epoch4

            processedJ = await getMaxJuniorProcessed(0n, lpConfig.maxSeniorJuniorRatio);
            shares = toToken(6283);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(4633);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            paidS = toToken(723);
            await creditContract.makePayment(ethers.ZeroHash, processedJ + paidS);

            // Close epoch4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - paidS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - processedJ,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ + unprocessedS - (processedJ + paidS),
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - processedJ,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - paidS,
            );
        });

        it("Should close epoch successfully while processing multi epochs, \
        multi mature senior epochs are processed fully, \
        multi mature junior epochs are processed fully, \
        multi immature senior epochs are processed fully, \
        multi immature junior epochs are processed partially(\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 2);

            let settings = await poolConfigContract.getPoolSettings();
            let lpConfig = await poolConfigContract.getLPConfig();

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            let availableSeniorAmount =
                juniorTotalAssets * lpConfig.maxSeniorJuniorRatio - seniorTotalAssets;
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

            let totalAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, totalAssets);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedS + unprocessedJ,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            let paidS = toToken(13645);
            await creditContract.makePayment(ethers.ZeroHash, paidS);

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - paidS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ + unprocessedS - paidS,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - paidS,
            );
            unprocessedS = unprocessedS - paidS;

            // Epoch3

            let processedJ = unprocessedJ;
            shares = toToken(3748);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(105965);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let paidJ = toToken(647);

            await creditContract.makePayment(ethers.ZeroHash, processedJ + unprocessedS + paidJ);

            // Close epoch3

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - unprocessedS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - processedJ - paidJ,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ - processedJ - paidJ,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - processedJ - paidJ,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - unprocessedS,
            );
            unprocessedJ = unprocessedJ - processedJ - paidJ;
            unprocessedS = toToken(0);

            // Epoch4

            shares = toToken(5345);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(57483);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            paidJ = toToken(3343);
            await creditContract.makePayment(ethers.ZeroHash, unprocessedS + paidJ);

            // Close epoch4

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - unprocessedS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - paidJ,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ - paidJ,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(3);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - paidJ,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - unprocessedS,
            );
        });

        it("Should reserve balance in pool vault while mature junior epochs are processed partially because of maxSeniorJuniorRatio", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFlexCall(true, 1);

            let settings = await poolConfigContract.getPoolSettings();
            let lpConfig = await poolConfigContract.getLPConfig();

            let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            let availableSeniorAmount =
                juniorTotalAssets * lpConfig.maxSeniorJuniorRatio - seniorTotalAssets;
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

            let totalAssets = await poolVaultContract.totalAssets();
            await creditContract.drawdown(ethers.ZeroHash, totalAssets);

            // Close epoch1

            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            let [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
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
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedS + unprocessedJ,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(1);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorTotalAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorTotalAssets);

            // Epoch2

            shares = toToken(27468);
            unprocessedJ = unprocessedJ + shares;
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            shares = toToken(3647);
            unprocessedS = unprocessedS + shares;
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let processedJ = await getMaxJuniorProcessed(
                unprocessedS,
                lpConfig.maxSeniorJuniorRatio,
            );
            let leftAssets = toToken(36485);
            await creditContract.makePayment(
                ethers.ZeroHash,
                unprocessedS + processedJ + leftAssets,
            );

            // Close epoch2

            lastEpoch = await epochManagerContract.currentEpoch();
            ts = lastEpoch.endTime + 60n * 5n;
            await setNextBlockTimestamp(ts);
            [endTime] = getNextDueDate(
                settings.calendarUnit,
                lastEpoch.endTime,
                ts,
                settings.payPeriodInCalendarUnit,
            );

            seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
            juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

            await expect(epochManagerContract.closeEpoch())
                .to.emit(epochManagerContract, "EpochClosed")
                .withArgs(
                    lastEpoch.id,
                    seniorTotalAssets - unprocessedS,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    juniorTotalAssets - processedJ,
                    CONSTANTS.PRICE_DECIMALS_FACTOR,
                    unprocessedJ - processedJ,
                )
                .to.emit(epochManagerContract, "NewEpochStarted")
                .withArgs(BigInt(lastEpoch.id) + 1n, endTime);

            expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
            expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(0);
            expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
            expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorTotalAssets - processedJ,
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorTotalAssets - unprocessedS,
            );

            expect(await poolVaultContract.getAvailableLiquidity()).to.equal(0);
            expect(await poolVaultContract.getAvailableReservation()).to.equal(leftAssets);
        });
    });
});
