import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Calendar } from "../typechain-types";
import { CONSTANTS } from "./BaseTest";
import {
    dateToTimestamp,
    getFutureBlockTime,
    getNextDueDate,
    mineNextBlockWithTimestamp,
    timestampToMoment,
} from "./TestUtils";

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

    describe("getStartOfNextMonth", function () {
        it("Should return the timestamp of the beginning of the next month", async function () {
            const nextBlockTime = await getFutureBlockTime(2);
            await mineNextBlockWithTimestamp(nextBlockTime);

            const startOfThisMonth = timestampToMoment(nextBlockTime, "YYYY-MM-01");
            const startOfNextMonth = startOfThisMonth.add(1, "month");
            expect(await calendarContract.getStartOfNextMonth()).to.equal(startOfNextMonth.unix());
        });
    });

    describe("getStartOfNextQuarter", function () {
        it("Should return the timestamp of the beginning of next quarter", async function () {
            let nextBlockTime;
            const currentMoment = Date.now();
            // Test all 4 quarters. Ths guarantees that we'll cover both cases where
            // 1. This quarter and the next quarter are in the same year.
            // 2. This quarter and the next quarter are in different years.
            for (let i = 0; i < 4; ++i) {
                nextBlockTime = currentMoment + i * CONSTANTS.MAX_SECONDS_IN_A_QUARTER;
                await mineNextBlockWithTimestamp(nextBlockTime);

                const startOfThisQuarter = timestampToMoment(nextBlockTime).startOf("quarter");
                const startOfNextQuarter = startOfThisQuarter.add(1, "quarter");
                expect(await calendarContract.getStartOfNextQuarter()).to.equal(
                    startOfNextQuarter.unix(),
                );
            }
        });
    });

    describe("getStartOfTomorrow", function () {
        it("Should return the timestamp of the beginning of tomorrow", async function () {
            const nextBlockTime = await getFutureBlockTime(2);
            await mineNextBlockWithTimestamp(nextBlockTime);

            const startOfToday = timestampToMoment(nextBlockTime).startOf("day");
            const startOfTomorrow = startOfToday.add(1, "day");
            expect(await calendarContract.getStartOfTomorrow()).to.equal(startOfTomorrow.unix());
        });
    });

    describe("getStartOfThisMonth", function () {
        it("Should return the timestamp of the beginning of this month", async function () {
            const nextBlockTime = await getFutureBlockTime(2);
            await mineNextBlockWithTimestamp(nextBlockTime);

            const startOfThisMonth = timestampToMoment(nextBlockTime, "YYYY-MM-01");
            expect(await calendarContract.getStartOfThisMonth()).to.equal(startOfThisMonth.unix());
        });
    });

    describe("getStartOfThisQuarter", function () {
        it("Should return the timestamp of the beginning of this quarter", async function () {
            const nextBlockTime = await getFutureBlockTime(2);
            await mineNextBlockWithTimestamp(nextBlockTime);

            const startOfThisQuarter = timestampToMoment(nextBlockTime).startOf("quarter");
            expect(await calendarContract.getStartOfThisQuarter()).to.equal(
                startOfThisQuarter.unix(),
            );
        });
    });

    describe("getStartOfToday", function () {
        it("Should return the timestamp of the beginning of today", async function () {
            const nextBlockTime = await getFutureBlockTime(2);
            await mineNextBlockWithTimestamp(nextBlockTime);

            const startOfToday = timestampToMoment(nextBlockTime).startOf("day");
            expect(await calendarContract.getStartOfToday()).to.equal(startOfToday.unix());
        });
    });

    describe("getNextDueDate", function () {
        async function testGetNextDueDate(periodDuration: number, lastDueDate: number) {
            const nextBlockTime = await getFutureBlockTime(2);
            await mineNextBlockWithTimestamp(nextBlockTime);

            const result = await calendarContract.getNextDueDate(periodDuration, lastDueDate);
            const [dueDate, numberOfPeriodsPassed] = getNextDueDate(
                lastDueDate,
                nextBlockTime,
                periodDuration,
            );
            expect(result.numberOfPeriodsPassed).to.equal(numberOfPeriodsPassed);
            expect(result.dueDate).to.equal(dueDate);
        }

        it("Should return the correct due date when lastDueDate is 0", async function () {
            await testGetNextDueDate(1, 0);
        });

        it("Should return the correct due date when lastDueDate is not 0", async function () {
            await testGetNextDueDate(3, dateToTimestamp("2023-02-01"));
        });
    });

    describe("getNextPeriod", function () {
        it("getNextPeriod while unit is Month and lastDueDate is 0", async function () {
            const nextBlockTime = await getFutureBlockTime(2);
            await mineNextBlockWithTimestamp(nextBlockTime);

            const periods = 1;
            const dueDateInNextPeriod = await calendarContract.getNextPeriod(periods, 0);
            const [dueDate] = getNextDueDate(0, nextBlockTime, periods);
            expect(dueDateInNextPeriod).to.equal(dueDate);
        });

        it("getNextPeriod while unit is Month and lastDueDate is not 0", async function () {
            const nextBlockTime = await getFutureBlockTime(2);
            await mineNextBlockWithTimestamp(nextBlockTime);

            const lastDate = dateToTimestamp("2023-02-01");

            const periods = 3;
            const dueDateInNextPeriod = await calendarContract.getNextPeriod(periods, lastDate);
            const [dueDate] = getNextDueDate(lastDate, lastDate, periods);
            expect(dueDateInNextPeriod).to.equal(dueDate);
        });
    });
});
