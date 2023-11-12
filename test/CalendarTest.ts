import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import moment from "moment";
import { Calendar } from "../typechain-types";
import { CONSTANTS, PayPeriodDuration } from "./BaseTest";
import { getFutureBlockTime, mineNextBlockWithTimestamp, timestampToMoment } from "./TestUtils";

let calendarContract: Calendar;

// The frequent usage of `nextYear` in tests is intentional. This approach
// accommodates the blockchain requirement that the timestamp for the next block
// must be a future date. It also offers the flexibility to specify exact dates,
// which simplifies testing. By setting the timeline to the next year or any
// future year, we can easily schedule the mining of the next block for any
// desired date within that year.

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
            const nextYear = moment.utc().year() + 1;
            // Test all 4 quarters. Ths guarantees that we'll cover both scenarios below:
            // 1. This quarter and the next quarter are in the same year.
            // 2. This quarter and the next quarter are in different years.
            for (let i = 0; i < 4; ++i) {
                const nextBlockTime = moment
                    .utc({
                        year: nextYear,
                        month: i * 3,
                        day: 1,
                    })
                    .unix();
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

    describe("getStartOfThisHalfYear", function () {
        it("Should return the timestamp of the beginning of this half year", async function () {
            const nextYear = moment.utc().year() + 1;
            // Test both halves of the year.
            for (let i = 0; i < 2; i++) {
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: i * 6 + 1,
                    day: 28,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const startOfThisHalfYear = moment.utc({
                    year: nextYear,
                    month: i * 6,
                    day: 1,
                });
                expect(await calendarContract.getStartOfThisHalfYear()).to.equal(
                    startOfThisHalfYear.unix(),
                );
            }
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

    describe("getDaysPassedInPeriod", function () {
        describe("With monthly period duration", function () {
            it("Should return the correct values if the day is the 1st", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 1,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                const [daysPassed, totalDaysInPeriod] =
                    await calendarContract.getDaysPassedInPeriod(PayPeriodDuration.Monthly);
                expect(daysPassed).to.equal(0);
                expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_MONTH);
            });

            it("Should return the correct values if the day is the 31st", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 31,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                const [daysPassed, totalDaysInPeriod] =
                    await calendarContract.getDaysPassedInPeriod(PayPeriodDuration.Monthly);
                expect(daysPassed).to.equal(29);
                expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_MONTH);
            });

            it("Should return the correct values otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 28,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                const [daysPassed, totalDaysInPeriod] =
                    await calendarContract.getDaysPassedInPeriod(PayPeriodDuration.Monthly);
                expect(daysPassed).to.equal(27);
                expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_MONTH);
            });
        });

        describe("With quarterly period duration", function () {
            it("Should return the correct values if the day is the 1st", async function () {
                const nextYear = moment.utc().year() + 1;
                for (let i = 0; i < 12; i++) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 1,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const [daysPassed, totalDaysInPeriod] =
                        await calendarContract.getDaysPassedInPeriod(PayPeriodDuration.Quarterly);
                    expect(daysPassed).to.equal((i % 3) * CONSTANTS.DAYS_IN_A_MONTH);
                    expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_QUARTER);
                }
            });

            it("Should return the correct values if the day is the 31st", async function () {
                const nextYear = moment.utc().year() + 1;
                for (const i of [0, 2, 4, 6, 7, 9, 11]) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 31,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const [daysPassed, totalDaysInPeriod] =
                        await calendarContract.getDaysPassedInPeriod(PayPeriodDuration.Quarterly);
                    expect(daysPassed).to.equal((i % 3) * CONSTANTS.DAYS_IN_A_MONTH + 29);
                    expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_QUARTER);
                }
            });

            it("Should return the correct values otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                for (let i = 0; i < 12; i++) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 28,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const [daysPassed, totalDaysInPeriod] =
                        await calendarContract.getDaysPassedInPeriod(PayPeriodDuration.Quarterly);
                    expect(daysPassed).to.equal((i % 3) * CONSTANTS.DAYS_IN_A_MONTH + 27);
                    expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_QUARTER);
                }
            });
        });

        describe("With semi-annually period duration", function () {
            it("Should return the correct values if the day is the 1st", async function () {
                const nextYear = moment.utc().year() + 1;
                for (let i = 0; i < 12; i++) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 1,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const [daysPassed, totalDaysInPeriod] =
                        await calendarContract.getDaysPassedInPeriod(
                            PayPeriodDuration.SemiAnnually,
                        );
                    expect(daysPassed).to.equal((i % 6) * CONSTANTS.DAYS_IN_A_MONTH);
                    expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_HALF_YEAR);
                }
            });

            it("Should return the correct values if the day is the 31st", async function () {
                const nextYear = moment.utc().year() + 1;
                for (const i of [0, 2, 4, 6, 7, 9, 11]) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 31,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const [daysPassed, totalDaysInPeriod] =
                        await calendarContract.getDaysPassedInPeriod(
                            PayPeriodDuration.SemiAnnually,
                        );
                    expect(daysPassed).to.equal((i % 6) * CONSTANTS.DAYS_IN_A_MONTH + 29);
                    expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_HALF_YEAR);
                }
            });

            it("Should return the correct values otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                for (let i = 0; i < 12; i++) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 28,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const [daysPassed, totalDaysInPeriod] =
                        await calendarContract.getDaysPassedInPeriod(
                            PayPeriodDuration.SemiAnnually,
                        );
                    expect(daysPassed).to.equal((i % 6) * CONSTANTS.DAYS_IN_A_MONTH + 27);
                    expect(totalDaysInPeriod).to.equal(CONSTANTS.DAYS_IN_A_HALF_YEAR);
                }
            });
        });
    });

    describe("getDaysDiff", function () {
        describe("When the start and end dates fall within the same month", function () {
            it("Should return 0 if the start and end dates are the same", async function () {
                const date = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 30,
                });
                expect(await calendarContract.getDaysDiff(date.unix(), date.unix())).to.equal(0);
            });

            it("Should return 0 if the start and end dates are the same and both are on the 31st", async function () {
                const date = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 31,
                });
                expect(await calendarContract.getDaysDiff(date.unix(), date.unix())).to.equal(0);
            });

            it("Should return 0 if the start date is on the 30th and end date is on the 31st", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 30,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 31,
                });
                expect(
                    await calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.equal(0);
            });

            it("Should return the correct number of days if the end date is on the 31st, and the start date is earlier than the 30th", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 28,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 31,
                });
                expect(
                    await calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.equal(2);
            });

            it("Should return the correct number of days if the start and end dates are otherwise different", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 14,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 27,
                });
                expect(
                    await calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.equal(13);
            });
        });

        describe("When the start and end dates are in different months", function () {
            it("Should return the correct number of days if the start date is on the 31st", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 31,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 28,
                });
                expect(
                    await calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.equal(28);
            });

            it("Should return the correct number of days if the end date is on the 31st", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 30,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 2,
                    day: 31,
                });
                expect(
                    await calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.equal(60);
            });

            it("Should return the correct number of days if both the start the end dates are on the 31st", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 31,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 2,
                    day: 31,
                });
                expect(
                    await calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.equal(60);
            });

            it("Should return the correct number of days if neither the start nor end dates is on the 31st", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 14,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 2,
                    day: 27,
                });
                expect(
                    await calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.equal(73);
            });
        });

        describe("When the start date is later than the end date", function () {
            it("Should return 0 if the start date is on the 30th and end date is on the 31st", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 31,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 30,
                });
                await expect(
                    calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.be.revertedWithCustomError(calendarContract, "startDateLaterThanEndDate");
            });
        });
    });

    describe("getStartDateOfNextPeriod", function () {
        describe("With monthly period duration", function () {
            it("Should return the start date of the immediate next period relative to the current block timestamp is timestamp is 0", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 2,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const startDateOfNextPeriod = moment.utc({
                    year: nextYear,
                    month: 4,
                    day: 1,
                });
                expect(
                    await calendarContract.getStartDateOfNextPeriod(PayPeriodDuration.Monthly, 0),
                ).to.equal(startDateOfNextPeriod.unix());
            });

            it("Should return the start date of the immediate next period relative to the given timestamp if it's not 0", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 6,
                    day: 27,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const timestamp = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 2,
                });
                // The start date should be based on `timestamp` rather `nextBlockTime`.
                const startDateOfNextPeriod = moment.utc({
                    year: nextYear,
                    month: 4,
                    day: 1,
                });
                expect(
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        timestamp.unix(),
                    ),
                ).to.equal(startDateOfNextPeriod.unix());
            });
        });

        describe("With quarterly period duration", function () {
            it("Should return the start date of the immediate next period relative to the current block timestamp is timestamp is 0", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 2,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const startDateOfNextPeriod = moment.utc({
                    year: nextYear,
                    month: 6,
                    day: 1,
                });
                expect(
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Quarterly,
                        0,
                    ),
                ).to.equal(startDateOfNextPeriod.unix());
            });

            it("Should return the start date of the immediate next period relative to the given timestamp if it's not 0", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 6,
                    day: 27,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const timestamp = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 2,
                });
                // The start date should be based on `timestamp` rather `nextBlockTime`.
                const startDateOfNextPeriod = moment.utc({
                    year: nextYear,
                    month: 6,
                    day: 1,
                });
                expect(
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Quarterly,
                        timestamp.unix(),
                    ),
                ).to.equal(startDateOfNextPeriod.unix());
            });
        });

        describe("With semi-annually period duration", function () {
            it("Should return the start date of the immediate next period relative to the current block timestamp is timestamp is 0", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 0,
                    day: 2,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const startDateOfNextPeriod = moment.utc({
                    year: nextYear,
                    month: 6,
                    day: 1,
                });
                expect(
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.SemiAnnually,
                        0,
                    ),
                ).to.equal(startDateOfNextPeriod.unix());
            });

            it("Should return the start date of the immediate next period relative to the given timestamp if it's not 0", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 6,
                    day: 27,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const timestamp = moment.utc({
                    year: nextYear,
                    month: 0,
                    day: 2,
                });
                // The start date should be based on `timestamp` rather `nextBlockTime`.
                const startDateOfNextPeriod = moment.utc({
                    year: nextYear,
                    month: 6,
                    day: 1,
                });
                expect(
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.SemiAnnually,
                        timestamp.unix(),
                    ),
                ).to.equal(startDateOfNextPeriod.unix());
            });
        });
    });

    describe("getNextDueDate", function () {
        describe("With monthly period duration", function () {
            it("Should return the maturity date if the current block timestamp has surpassed the maturity date", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 1,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const maturityDate = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 31,
                });
                expect(
                    await calendarContract["getNextDueDate(uint8,uint256)"](
                        PayPeriodDuration.Monthly,
                        maturityDate.unix(),
                    ),
                ).to.equal(maturityDate.unix());
            });

            it(
                "Should return the maturity date if the current block timestamp has surpassed the beginning of the period" +
                    " that the maturity date is in",
                async function () {
                    const nextYear = moment.utc().year() + 1;
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: 3,
                        day: 2,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());

                    const maturityDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 15,
                    });
                    expect(
                        await calendarContract["getNextDueDate(uint8,uint256)"](
                            PayPeriodDuration.Monthly,
                            maturityDate.unix(),
                        ),
                    ).to.equal(maturityDate.unix());
                },
            );

            it("Should return the correct due date otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 31,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const maturityDate = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 15,
                });
                const nextDueDate = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 1,
                });
                expect(
                    await calendarContract["getNextDueDate(uint8,uint256)"](
                        PayPeriodDuration.Monthly,
                        maturityDate.unix(),
                    ),
                ).to.equal(nextDueDate.unix());
            });
        });

        describe("With quarterly period duration", function () {
            it("Should return the maturity date if the current block timestamp has surpassed the maturity date", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 1,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const maturityDate = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 31,
                });
                expect(
                    await calendarContract["getNextDueDate(uint8,uint256)"](
                        PayPeriodDuration.Quarterly,
                        maturityDate.unix(),
                    ),
                ).to.equal(maturityDate.unix());
            });

            it(
                "Should return the maturity date if the current block timestamp has surpassed the beginning of the period" +
                    " that the maturity date is in",
                async function () {
                    const nextYear = moment.utc().year() + 1;
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: 3,
                        day: 2,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());

                    const maturityDate = moment.utc({
                        year: nextYear,
                        month: 3,
                        day: 15,
                    });
                    expect(
                        await calendarContract["getNextDueDate(uint8,uint256)"](
                            PayPeriodDuration.Quarterly,
                            maturityDate.unix(),
                        ),
                    ).to.equal(maturityDate.unix());
                },
            );

            it("Should return the correct due date otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 14,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const maturityDate = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 15,
                });
                const nextDueDate = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 1,
                });
                expect(
                    await calendarContract["getNextDueDate(uint8,uint256)"](
                        PayPeriodDuration.Quarterly,
                        maturityDate.unix(),
                    ),
                ).to.equal(nextDueDate.unix());
            });
        });

        describe("With semi-annually period duration", function () {
            it("Should return the maturity date if the current block timestamp has surpassed the maturity date", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 1,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const maturityDate = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 31,
                });
                expect(
                    await calendarContract["getNextDueDate(uint8,uint256)"](
                        PayPeriodDuration.SemiAnnually,
                        maturityDate.unix(),
                    ),
                ).to.equal(maturityDate.unix());
            });

            it(
                "Should return the maturity date if the current block timestamp has surpassed the beginning of the period" +
                    " that the maturity date is in",
                async function () {
                    const nextYear = moment.utc().year() + 1;
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: 3,
                        day: 2,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());

                    const maturityDate = moment.utc({
                        year: nextYear,
                        month: 3,
                        day: 15,
                    });
                    expect(
                        await calendarContract["getNextDueDate(uint8,uint256)"](
                            PayPeriodDuration.SemiAnnually,
                            maturityDate.unix(),
                        ),
                    ).to.equal(maturityDate.unix());
                },
            );

            it("Should return the correct due date otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 31,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const maturityDate = moment.utc({
                    year: nextYear,
                    month: 7,
                    day: 15,
                });
                const nextDueDate = moment.utc({
                    year: nextYear,
                    month: 6,
                    day: 1,
                });
                expect(
                    await calendarContract["getNextDueDate(uint8,uint256)"](
                        PayPeriodDuration.SemiAnnually,
                        maturityDate.unix(),
                    ),
                ).to.equal(nextDueDate.unix());
            });
        });
    });

    describe("getNumPeriodsPassed", function () {
        describe("With monthly period duration", function () {
            it("Should return 1 if the start and end dates are within the same period", async function () {
                const nextYear = moment.utc().year() + 1;
                const startDate = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 28,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 2 if the end date is in the immediate next period of the start date", async function () {
                const nextYear = moment.utc().year() + 1;
                const startDate = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 14,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(2);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart", async function () {
                const nextYear = moment.utc().year() + 1;
                const startDate = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 14,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(3);
            });
        });

        describe("With quarterly period duration", function () {
            it("Should return 1 if the start and end dates are within the same period", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 2,
                    day: 28,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Quarterly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 2 if the end date is in the immediate next period of the start date", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 14,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Quarterly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(2);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 11,
                    day: 14,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Quarterly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(4);
            });
        });

        describe("With semi-annually period duration", function () {
            it("Should return 1 if the start and end dates are within the same period", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 28,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 2 if the end date is in the immediate next period of the start date", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 6,
                    day: 14,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(2);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2025,
                    month: 11,
                    day: 14,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(4);
            });
        });
    });

    describe("getMaturityDate", function () {
        describe("With monthly period duration", function () {
            describe("When the timestamp is on special days", function () {
                it("Should return the correct maturity date if the cycle starts on the 1st of the month", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 1,
                    });
                    for (const numPeriods of [1, 2, 3]) {
                        // The case for February is covered when `numPeriods == 2`
                        const expectedMaturityDate = moment.utc({
                            year: nextYear,
                            month: numPeriods,
                            day: 1,
                        });
                        expect(
                            await calendarContract.getMaturityDate(
                                PayPeriodDuration.Monthly,
                                numPeriods,
                                timestamp.unix(),
                            ),
                        ).to.equal(expectedMaturityDate.unix());
                    }
                });

                it("Should return the beginning of the last day of Feb if the cycle starts on 1/30 or 1/31 and there are 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const expectedMaturityDate = moment
                        .utc()
                        .year(nextYear)
                        .month(1)
                        .endOf("month")
                        .startOf("day");
                    for (const day of [30, 31]) {
                        const timestamp = moment.utc({
                            year: nextYear,
                            month: 0,
                            day: day,
                        });
                        expect(
                            await calendarContract.getMaturityDate(
                                PayPeriodDuration.Monthly,
                                2,
                                timestamp.unix(),
                            ),
                        ).to.equal(expectedMaturityDate.unix());
                    }
                });

                it(
                    "Should return the beginning of the 30th of the month" +
                        " that the due date is in if the cycle starts on the 31st of the month" +
                        " and the due date does not fall in Feb",
                    async function () {
                        const nextYear = moment.utc().year() + 1;
                        const timestamp = moment.utc({
                            year: nextYear,
                            month: 0,
                            day: 31,
                        });
                        const expectedMaturityDate = moment.utc({
                            year: nextYear,
                            month: 2,
                            day: 30,
                        });
                        expect(
                            await calendarContract.getMaturityDate(
                                PayPeriodDuration.Monthly,
                                3,
                                timestamp.unix(),
                            ),
                        ).to.equal(expectedMaturityDate.unix());
                    },
                );
            });

            describe("When the timestamp is not on special days", function () {
                it("Should return the correct maturity date if there are only 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 10,
                    });
                    const numPeriods = 2;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear,
                        month: 3,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.Monthly,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });

                it("Should return the correct maturity date if there are more than 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 10,
                    });
                    const numPeriods = 4;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear,
                        month: 5,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.Monthly,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });
            });
        });

        describe("With quarterly period duration", function () {
            describe("When the timestamp is on special days", function () {
                it("Should return the correct maturity date if the cycle starts on the 1st of the month", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 1,
                    });
                    for (const numPeriods of [1, 2, 3]) {
                        const expectedMaturityDate = moment.utc({
                            year: nextYear,
                            month: numPeriods * 3,
                            day: 1,
                        });
                        expect(
                            await calendarContract.getMaturityDate(
                                PayPeriodDuration.Quarterly,
                                numPeriods,
                                timestamp.unix(),
                            ),
                        ).to.equal(expectedMaturityDate.unix());
                    }
                });

                it("Should return the correct maturity date if the start date is on the 31st and there are only 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 31,
                    });
                    const numPeriods = 2;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear,
                        month: 3,
                        day: 30,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.Quarterly,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });

                it("Should return the correct maturity date if the start date is on the 31st and there are more than 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 31,
                    });
                    const numPeriods = 3;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear,
                        month: 6,
                        day: 30,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.Quarterly,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });
            });

            describe("When the timestamp is not on special days", function () {
                it("Should return the correct maturity date if there are only 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 10,
                    });
                    const numPeriods = 2;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear,
                        month: 5,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.Quarterly,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });

                it("Should return the correct maturity date if there are more than 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 10,
                    });
                    const numPeriods = 4;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear,
                        month: 11,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.Quarterly,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });
            });
        });

        describe("With semi-annually period duration", function () {
            describe("When the timestamp is on special days", function () {
                it("Should return the correct maturity date if the cycle starts on the 1st of the month", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 1,
                    });
                    for (const numPeriods of [1, 2, 3]) {
                        const expectedMaturityDate = moment.utc({
                            year: nextYear + numPeriods / 2,
                            month: (numPeriods % 2) * 6,
                            day: 1,
                        });
                        expect(
                            await calendarContract.getMaturityDate(
                                PayPeriodDuration.SemiAnnually,
                                numPeriods,
                                timestamp.unix(),
                            ),
                        ).to.equal(expectedMaturityDate.unix());
                    }
                });

                it("Should return the correct maturity date if the start date is on the 31st and there are only 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 31,
                    });
                    const numPeriods = 2;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear,
                        month: 6,
                        day: 30,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.SemiAnnually,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });

                it("Should return the correct maturity date if the start date is on the 31st and there are more than 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 31,
                    });
                    const numPeriods = 3;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear + 1,
                        month: 0,
                        day: 30,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.SemiAnnually,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });
            });

            describe("When the timestamp is not on special days", function () {
                it("Should return the correct maturity date if there are only 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 10,
                    });
                    const numPeriods = 2;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear,
                        month: 8,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.SemiAnnually,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });

                it("Should return the correct maturity date if there are more than 2 periods", async function () {
                    const nextYear = moment.utc().year() + 1;
                    const timestamp = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 10,
                    });
                    const numPeriods = 4;
                    const expectedMaturityDate = moment.utc({
                        year: nextYear + 1,
                        month: 8,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getMaturityDate(
                            PayPeriodDuration.SemiAnnually,
                            numPeriods,
                            timestamp.unix(),
                        ),
                    ).to.equal(expectedMaturityDate.unix());
                });
            });
        });
    });
});
