import { ethers } from "hardhat";
import { expect } from "chai";
import moment from "moment";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { getLatestBlock, mineNextBlockWithTimestamp } from "./TestUtils";
import { CONSTANTS, getNextDueDate } from "./BaseTest";
import { Calendar } from "../typechain-types";

let calendarContract: Calendar;

describe("Calendar Test", function () {
    async function prepare() {
        const Calendar = await ethers.getContractFactory("Calendar");
        calendarContract = await Calendar.deploy();
        await calendarContract.waitForDeployment();
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("getNextDueDate", function () {
        it("getNextDueDate while unit is Day and lastDueDate is 0", async function () {
            let nextDate = Math.ceil(Date.now() / 1000) + 2;
            const block = await getLatestBlock();
            if (block!.timestamp > nextDate) {
                nextDate = block!.timestamp + 2;
            }
            await mineNextBlockWithTimestamp(nextDate);

            const period = 2;
            const result = await calendarContract.getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_DAY,
                period,
                0,
            );
            const [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_DAY,
                0,
                nextDate,
                period,
            );
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Day and lastDueDate is not 0", async function () {
            let nextDate = Math.ceil(Date.now() / 1000) + 2;
            const block = await getLatestBlock();
            if (block!.timestamp > nextDate) {
                nextDate = block!.timestamp + 2;
            }
            await mineNextBlockWithTimestamp(nextDate);

            const lastDate = moment.utc("2023-07-01").unix();

            const period = 3;
            const result = await calendarContract.getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_DAY,
                period,
                lastDate,
            );
            const [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_DAY,
                lastDate,
                nextDate,
                period,
            );
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Month and lastDueDate is 0", async function () {
            let nextDate = Math.ceil(Date.now() / 1000) + 2;
            const block = await getLatestBlock();
            if (block!.timestamp > nextDate) {
                nextDate = block!.timestamp + 2;
            }
            await mineNextBlockWithTimestamp(nextDate);

            const period = 1;
            const result = await calendarContract.getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_MONTH,
                period,
                0,
            );
            const [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_MONTH,
                0,
                nextDate,
                period,
            );
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });

        it("getNextDueDate while unit is Month and lastDueDate is not 0", async function () {
            let nextDate = Math.ceil(Date.now() / 1000) + 2;
            const block = await getLatestBlock();
            if (block!.timestamp > nextDate) {
                nextDate = block!.timestamp + 2;
            }
            await mineNextBlockWithTimestamp(nextDate);

            const lastDate = moment.utc("2023-02-01").unix();

            const period = 3;
            const result = await calendarContract.getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_MONTH,
                period,
                lastDate,
            );
            const [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                CONSTANTS.CALENDAR_UNIT_MONTH,
                lastDate,
                nextDate,
                period,
            );
            // console.log(`dueDate: ${dueDate}, numberOfPeriodsPassed: ${numberOfPeriodsPassed}`);
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        });
    });
});
