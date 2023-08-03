const {ethers} = require("hardhat");
const {expect} = require("chai");
const moment = require("moment");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {mineNextBlockWithTimestamp} = require("./TestUtils");

const DAY_UNIT = 0;
const MONTH_UNIT = 1;

let calendar;

function getNextDate(lastDate, currentDate, periodDuration) {
    let date;
    let numberOfPeriodsPassed = 0;
    let dayCount = 0;
    if (lastDate > 0) {
        date = moment.unix(lastDate);
        numberOfPeriodsPassed = Math.floor(
            moment.unix(currentDate).diff(date, "days") / periodDuration
        );
    } else {
        date = moment.utc(moment.unix(currentDate).utc().format("YYYY-MM-DD"));
        dayCount = 1;
    }
    dayCount += (numberOfPeriodsPassed + 1) * periodDuration;
    date.add(dayCount, "days");
    return [date.unix(), numberOfPeriodsPassed];
}

function getNextMonth(lastDate, currentDate, periodDuration) {
    let date;
    let numberOfPeriodsPassed = 0;
    let monthCount = 0;
    if (lastDate > 0) {
        date = moment.unix(lastDate);
        numberOfPeriodsPassed = Math.floor(
            moment.unix(currentDate).diff(date, "months") / periodDuration
        );
    } else {
        date = moment.utc(moment.unix(currentDate).utc().format("YYYY-MM-01"));
        monthCount = 1;
    }
    monthCount += (numberOfPeriodsPassed + 1) * periodDuration;
    date.add(monthCount, "months");
    return [date.unix(), numberOfPeriodsPassed];
}

describe("Calendar", function () {
    before(async function () {
        [defaultDeployer] = await ethers.getSigners();
    });

    async function prepare() {
        const Calendar = await ethers.getContractFactory("Calendar");
        calendar = await Calendar.deploy();
        await calendar.deployed();
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("getNextDueDate", function () {
        it("getNextDueDate while unit is Day and lastDueDate is 0", async function () {
            let nextDate = Math.ceil(Date.now() / 1000) + 2;
            await mineNextBlockWithTimestamp(nextDate);

            let period = 2;
            let result = await calendar.getNextDueDate(DAY_UNIT, period, 0);
            let [dueDate, numberOfPeriodsPassed] = getNextDate(0, nextDate, period);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Day and lastDueDate is not 0", async function () {
            let nextDate = Math.ceil(Date.now() / 1000) + 2;
            await mineNextBlockWithTimestamp(nextDate);

            let lastDate = moment.utc("2023-07-01").unix();

            let period = 3;
            let result = await calendar.getNextDueDate(DAY_UNIT, period, lastDate);
            let [dueDate, numberOfPeriodsPassed] = getNextDate(lastDate, nextDate, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Month and lastDueDate is 0", async function () {
            let nextDate = Math.ceil(Date.now() / 1000) + 2;
            await mineNextBlockWithTimestamp(nextDate);

            let period = 1;
            let result = await calendar.getNextDueDate(MONTH_UNIT, period, 0);
            let [dueDate, numberOfPeriodsPassed] = getNextMonth(0, nextDate, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Month and lastDueDate is not 0", async function () {
            let nextDate = Math.ceil(Date.now() / 1000) + 2;
            await mineNextBlockWithTimestamp(nextDate);

            let lastDate = moment.utc("2023-02-01").unix();

            let period = 3;
            let result = await calendar.getNextDueDate(MONTH_UNIT, period, lastDate);
            let [dueDate, numberOfPeriodsPassed] = getNextMonth(lastDate, nextDate, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });
    });
});
