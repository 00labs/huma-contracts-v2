const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {deployProtocolContracts, deployAndSetupPoolContracts, CONSTANTS} = require("./BaseTest");
const {toToken, mineNextBlockWithTimestamp} = require("./TestUtils");
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

function getNextEpochEndTime(currentDate, calendarUnit, countInCalendarUnit) {
    let date;
    if (calendarUnit === 0) {
        date = moment.utc(moment.unix(currentDate).utc().format("YYYY-MM-DD"));
        date = date.add(countInCalendarUnit + 1, "days");
    } else if (calendarUnit === 1) {
        date = moment.utc(moment.unix(currentDate).utc().format("YYYY-MM-01"));
        date = date.add(countInCalendarUnit + 1, "months");
    }
    return date.unix();
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
        await expect(poolContract.connect(poolOwner).enablePool()).to.emit(
            epochManagerContract,
            "NewEpochStarted"
        );
        let block = await ethers.provider.getBlock();
        let ts = block.timestamp;

        let currentEpoch = await epochManagerContract.currentEpoch();
        let endTime = getNextEpochEndTime(
            ts,
            settings.calendarUnit,
            settings.epochWindowInCalendarUnit
        );
        expect(currentEpoch.id).to.equal(2);
        expect(currentEpoch.nextEndTime).to.equal(endTime);

        // Goes forward one day and start a new epoch
        await mineNextBlockWithTimestamp(ts + 60 * 60 * 24);
        await expect(poolContract.connect(poolOwner).enablePool()).to.emit(
            epochManagerContract,
            "NewEpochStarted"
        );
        block = await ethers.provider.getBlock();
        ts = block.timestamp;

        currentEpoch = await epochManagerContract.currentEpoch();
        endTime = getNextEpochEndTime(
            ts,
            settings.calendarUnit,
            settings.epochWindowInCalendarUnit
        );
        expect(currentEpoch.id).to.equal(3);
        expect(currentEpoch.nextEndTime).to.equal(endTime);
    });

    it("Should not close epoch while protocol is paused or pool is not on", async function () {});

    it("Should not close epoch before end time", async function () {});

    it("Should close epoch successfully", async function () {
        let withdrawalShares = toToken(1000);
        await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(withdrawalShares);
        await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(withdrawalShares);

        let currentEpoch = await epochManagerContract.currentEpoch();
        await mineNextBlockWithTimestamp(currentEpoch.nextEndTime.toNumber() + 60 * 5);

        let juniorTotalAssets = await juniorTrancheVaultContract.totalAssets();
        let seniorTotalAssets = await seniorTrancheVaultContract.totalAssets();

        await expect(epochManagerContract.closeEpoch())
            .to.emit(epochManagerContract, "EpochClosed")
            .withArgs(
                currentEpoch.id,
                seniorTotalAssets.sub(withdrawalShares),
                1,
                juniorTotalAssets.sub(withdrawalShares),
                1,
                0
            )
            .to.emit(epochManagerContract, "NewEpochStarted");
    });
});
