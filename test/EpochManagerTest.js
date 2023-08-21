const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {
    deployProtocolContracts,
    deployAndSetupPoolContracts,
    CONSTANTS,
    getNextDueDate,
    checkEpochInfo,
} = require("./BaseTest");
const {toToken, mineNextBlockWithTimestamp, setNextBlockTimestamp} = require("./TestUtils");
const moment = require("moment");

let defaultDeployer, protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury, evaluationAgent, poolOperator;
let lender, lender2;

let eaNFTContract, humaConfigContract, mockTokenContract;
let poolConfigContract,
    platformFeeManagerContract,
    poolVaultContract,
    calendarContract,
    lossCovererContract,
    tranchesPolicyContract,
    poolContract,
    epochManagerContract,
    seniorTrancheVaultContract,
    juniorTrancheVaultContract,
    creditContract;

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
            poolOwner
        );

        [
            poolConfigContract,
            platformFeeManagerContract,
            poolVaultContract,
            calendarContract,
            lossCovererContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, lender2]
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

        // console.log(
        //     `juniorTrancheVaultContract.totalAssets: ${await juniorTrancheVaultContract.totalAssets()}`
        // );
        // console.log(
        //     `seniorTrancheVaultContract.totalAssets: ${await seniorTrancheVaultContract.totalAssets()}`
        // );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should not allow non-Pool to start new epoch", async function () {
        await expect(epochManagerContract.startNewEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "notPool"
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
            settings.epochWindowInCalendarUnit
        );
        await expect(poolContract.connect(poolOwner).enablePool())
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        // Goes forward one day and start a new epoch
        let ts = endTime + 60 * 5;
        await mineNextBlockWithTimestamp(ts);
        lastEpoch = await epochManagerContract.currentEpoch();
        [endTime] = getNextDueDate(
            settings.calendarUnit,
            0,
            ts,
            settings.epochWindowInCalendarUnit
        );
        await expect(poolContract.connect(poolOwner).enablePool())
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);
    });

    it("Should not close epoch while protocol is paused or pool is not on", async function () {
        await humaConfigContract.connect(protocolOwner).pause();
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "protocolIsPaused"
        );
        await humaConfigContract.connect(protocolOwner).unpause();

        await poolContract.connect(poolOwner).disablePool();
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            poolConfigContract,
            "poolIsNotOn"
        );
        await poolContract.connect(poolOwner).enablePool();
    });

    it("Should not close epoch before end time", async function () {
        await expect(epochManagerContract.closeEpoch()).to.be.revertedWithCustomError(
            epochManagerContract,
            "closeTooSoon"
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
            settings.epochWindowInCalendarUnit
        );

        let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets.sub(withdrawalShares),
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets.sub(withdrawalShares)
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
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime.toNumber() + 60 * 5;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime.toNumber(),
            ts,
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
        );

        seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets.sub(allShares),
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets.sub(allShares)
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
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime.toNumber() + 60 * 5;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime.toNumber(),
            ts,
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
        );

        seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets.sub(partialPaid),
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares.sub(partialPaid)
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(2);
        expect(await seniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(2);
        expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
            seniorTotalAssets.sub(partialPaid)
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
            settings.epochWindowInCalendarUnit
        );

        let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets.sub(withdrawalShares),
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(withdrawalShares)
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
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime.toNumber() + 60 * 5;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime.toNumber(),
            ts,
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
        );

        seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets.sub(allShares),
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(allShares)
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
        await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

        // Close epoch1

        let lastEpoch = await epochManagerContract.currentEpoch();
        let ts = lastEpoch.endTime.toNumber() + 60 * 5;
        await setNextBlockTimestamp(ts);
        let [endTime] = getNextDueDate(
            settings.calendarUnit,
            lastEpoch.endTime.toNumber(),
            ts,
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
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
                allShares
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
            settings.epochWindowInCalendarUnit
        );

        seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();
        juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                lastEpoch.id,
                seniorTotalAssets,
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets.sub(partialPaid),
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                allShares.sub(partialPaid)
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime);

        expect((await juniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(3);
        expect(await juniorTrancheVaultContract.unprocessedIndexOfEpochIds()).to.equal(1);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorTotalAssets.sub(partialPaid)
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
            settings.epochWindowInCalendarUnit
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
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                juniorTotalAssets.sub(withdrawalShares),
                CONSTANTS.PRICE_DECIMALS_FACTOR,
                0
            )
            .to.emit(epochManagerContract, "NewEpochStarted")
            .withArgs(lastEpoch.id.toNumber() + 1, endTime)
            .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
            .withArgs(1, withdrawalShares, withdrawalShares, 1)
            .to.emit(juniorTrancheVaultContract, "EpochsProcessed")
            .withArgs(1, withdrawalShares, withdrawalShares, 1);

        expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
            juniorTotalSupply.sub(withdrawalShares)
        );
        expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
            juniorBalance.add(withdrawalShares)
        );
        expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
            seniorTotalSupply.sub(withdrawalShares)
        );
        expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
            seniorBalance.add(withdrawalShares)
        );

        let epoch = await seniorTrancheVaultContract.epochMap(1);
        checkEpochInfo(epoch, 1, withdrawalShares, withdrawalShares, withdrawalShares);
        epoch = await juniorTrancheVaultContract.epochMap(1);
        checkEpochInfo(epoch, 1, withdrawalShares, withdrawalShares, withdrawalShares);

        let res = await seniorTrancheVaultContract.unprocessedEpochInfos();
        expect(res.length).to.equal(0);
        res = await juniorTrancheVaultContract.unprocessedEpochInfos();
        expect(res.length).to.equal(0);
    });

    it("Should close epoch successfully while processing multi epochs, \
    multi senior epochs are processed fully, \
    multi junior epochs are processed fully", async function () {});

    it("Should close epoch successfully while processing multi epochs, \
    multi senior epochs are processed fully, \
    multi junior epochs are processed partially(\
    some are processed fully, some are processed partially and some are unprocessed)", async function () {});

    describe("Flex Loan Tests", function () {
        it("Should close epoch successfully while processing one immature senior fully", async function () {});

        it("Should close epoch successfully while processing multi immature senior fully", async function () {});

        it("Should close epoch successfully while processing multi immature senior(\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {});

        it("Should close epoch successfully while processing one immature junior fully", async function () {});

        it("Should close epoch successfully while processing multi immature junior fully", async function () {});

        it("Should close epoch successfully while processing multi immature junior(\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {});

        it("Should close epoch successfully while processing one mature senior, one mature junior, \
        one immature senior and one immature junior fully", async function () {});

        it("Should close epoch successfully while processing multi epochs, \
        multi mature senior epochs are processed fully, \
        multi mature junior epochs are processed fully, \
        multi immature senior epochs are processed fully, \
        multi immature junior epochs are processed fully", async function () {});

        it("Should close epoch successfully while processing multi epochs, \
        multi mature senior epochs are processed fully, \
        multi mature junior epochs are processed partially(\
        some are processed fully, some are processed partially and some are unprocessed), \
        multi immature senior epochs are processed partially(\
        some are processed fully, some are processed partially and some are unprocessed), \
        multi immature junior epochs are unprocessed", async function () {});

        it("Should close epoch successfully while processing multi epochs, \
        multi mature senior epochs are processed fully, \
        multi mature junior epochs are processed partially(\
        some are processed fully, some are processed partially and some are unprocessed), \
        multi immature senior epochs are processed fully, \
        multi immature junior epochs are processed partially(\
        some are processed fully, some are processed partially and some are unprocessed)", async function () {});
    });
});
