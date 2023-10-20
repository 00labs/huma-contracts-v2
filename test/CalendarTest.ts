import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { CONSTANTS, getNextDueDate } from "./BaseTest";
import { dateToTimestamp, getNextTime, mineNextBlockWithTimestamp } from "./TestUtils";
import { Calendar } from "../typechain-types";

let calendarContract: Calendar;

describe("Calendar Test", function () {
    async function prepare() {
        const Calendar = await ethers.getContractFactory("Calendar");
        calendarContract = await Calendar.deploy();
        await calendarContract.deployed();
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("getNextDueDate", function () {
        it("getNextDueDate while unit is Day and lastDueDate is 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let period = 2;
            let result = await calendarContract.getNextDueDate(period, 0);
            let [dueDate, numberOfPeriodsPassed] = getNextDueDate(0, nextTime, period);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Day and lastDueDate is not 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let lastDate = dateToTimestamp("2023-07-01");

            let period = 3;
            let result = await calendarContract.getNextDueDate(period, lastDate);
            let [dueDate, numberOfPeriodsPassed] = getNextDueDate(lastDate, nextTime, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Month and lastDueDate is 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let period = 1;
            let result = await calendarContract.getNextDueDate(period, 0);
            let [dueDate, numberOfPeriodsPassed] = getNextDueDate(0, nextTime, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Month and lastDueDate is not 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let lastDate = dateToTimestamp("2023-02-01");

            let period = 3;
            let result = await calendarContract.getNextDueDate(period, lastDate);
            let [dueDate, numberOfPeriodsPassed] = getNextDueDate(lastDate, nextTime, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });
    });

    describe("getNextPeriod", function () {
        it("getNextPeriod while unit is Day and lastDueDate is 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let period = 2;
            let dueDateInNextPeriod = await calendarContract.getNextPeriod(period, 0);
            let [dueDate] = getNextDueDate(0, nextTime, period);
            expect(dueDateInNextPeriod).to.equal(dueDate);
        });

        it("getNextPeriod while unit is Day and lastDueDate is not 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let lastDate = dateToTimestamp("2023-07-01");

            let period = 3;
            let dueDateInNextPeriod = await calendarContract.getNextPeriod(period, lastDate);
            let [dueDate] = getNextDueDate(lastDate, lastDate, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(dueDateInNextPeriod).to.equal(dueDate);
        });

        it("getNextPeriod while unit is Month and lastDueDate is 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let period = 1;
            let dueDateInNextPeriod = await calendarContract.getNextPeriod(period, 0);
            let [dueDate] = getNextDueDate(0, nextTime, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(dueDateInNextPeriod).to.equal(dueDate);
        });

        it("getNextPeriod while unit is Month and lastDueDate is not 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let lastDate = dateToTimestamp("2023-02-01");

            let period = 3;
            let dueDateInNextPeriod = await calendarContract.getNextPeriod(period, lastDate);
            let [dueDate] = getNextDueDate(lastDate, lastDate, period);
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(dueDateInNextPeriod).to.equal(dueDate);
        });
    });
});
