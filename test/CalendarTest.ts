import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { CONSTANTS, getNextDueDate } from "./BaseTest";
import { getNextTime, mineNextBlockWithTimestamp } from "./TestUtils";
import { Calendar } from "../typechain-types";
import moment from "moment";

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
            let result = await calendarContract.getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_DAY,
                period,
                0,
            );
            let [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_DAY,
                0,
                nextTime,
                period,
            );
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Day and lastDueDate is not 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let lastDate = moment.utc("2023-07-01").unix();

            let period = 3;
            let result = await calendarContract.getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_DAY,
                period,
                lastDate,
            );
            let [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_DAY,
                lastDate,
                nextTime,
                period,
            );
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Month and lastDueDate is 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let period = 1;
            let result = await calendarContract.getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_MONTH,
                period,
                0,
            );
            let [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_MONTH,
                0,
                nextTime,
                period,
            );
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Month and lastDueDate is not 0", async function () {
            let nextTime = await getNextTime(2);
            await mineNextBlockWithTimestamp(nextTime);

            let lastDate = moment.utc("2023-02-01").unix();

            let period = 3;
            let result = await calendarContract.getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_MONTH,
                period,
                lastDate,
            );
            let [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_MONTH,
                lastDate,
                nextTime,
                period,
            );
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });
    });
});
