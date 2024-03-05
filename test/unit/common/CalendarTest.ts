import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import moment from "moment";
import { Calendar } from "../../../typechain-types";
import { PayPeriodDuration } from "../../BaseTest";
import { evmRevert, evmSnapshot, mineNextBlockWithTimestamp } from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let calendarContract: Calendar;

// The frequent usage of `nextYear` in tests is intentional. This approach
// accommodates the blockchain requirement that the timestamp for the next block
// must be a future date. It also offers the flexibility to specify exact dates,
// which simplifies testing. By setting the timeline to the next year or any
// future year, we can easily schedule the mining of the next block for any
// desired date within that year.

describe("Calendar Test", function () {
    let sId: unknown;

    before(async function () {
        sId = await evmSnapshot();
    });

    after(async function () {
        if (sId) {
            await evmRevert(sId);
        }
    });

    async function prepare() {
        const Calendar = await ethers.getContractFactory("Calendar");
        calendarContract = await Calendar.deploy();
        await calendarContract.deployed();
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("getDaysRemainingInPeriod", function () {
        describe("With monthly period duration", function () {
            it("Should return 0 if the current timestamp and end date are on the same day", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 1,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                    nextBlockTime.unix(),
                );
                expect(daysRemaining).to.equal(0);
            });

            it("Should return the correct values if the day is the 1st", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 1,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                const endDate = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 1,
                });
                const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                    endDate.unix(),
                );
                expect(daysRemaining).to.equal(CONSTANTS.DAYS_IN_A_MONTH);
            });

            it("Should return the correct values if the day is the 31st", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 31,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                const endDate = moment.utc({
                    year: nextYear,
                    month: 3,
                    day: 1,
                });
                const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                    endDate.unix(),
                );
                expect(daysRemaining).to.equal(1);
            });

            it("Should return the correct values otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 14,
                });
                const endDate = moment.utc({
                    year: nextYear,
                    month: 2,
                    day: 1,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                    endDate.unix(),
                );
                expect(daysRemaining).to.equal(17);
            });

            it("Should revert if the current block timestamp has surpassed the next due date", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 14,
                });
                const endDate = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 13,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                await expect(
                    calendarContract.getDaysRemainingInPeriod(endDate.unix()),
                ).to.be.revertedWithCustomError(calendarContract, "StartDateLaterThanEndDate");
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
                    // `endDate` is the start of the next quarter relative to `nextBlockTime`.
                    const endDate = moment.utc({
                        year: nextYear + (i < 9 ? 0 : 1),
                        month: ((Math.floor(i / 3) + 1) * 3) % 12,
                        day: 1,
                    });
                    const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                        endDate.unix(),
                    );
                    expect(daysRemaining).to.equal((3 - (i % 3)) * CONSTANTS.DAYS_IN_A_MONTH);
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
                    const endDate = moment.utc({
                        year: nextYear + (i >= 9 ? 1 : 0),
                        month: ((Math.floor(i / 3) + 1) * 3) % 12,
                        day: 1,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                        endDate.unix(),
                    );
                    expect(daysRemaining).to.equal((2 - (i % 3)) * CONSTANTS.DAYS_IN_A_MONTH + 1);
                }
            });

            it("Should return the correct values otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                for (let i = 0; i < 12; i++) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 14,
                    });
                    const endDate = moment.utc({
                        year: nextYear + (i < 9 ? 0 : 1),
                        month: ((Math.floor(i / 3) + 1) * 3) % 12,
                        day: 1,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                        endDate.unix(),
                    );
                    expect(daysRemaining).to.equal((2 - (i % 3)) * CONSTANTS.DAYS_IN_A_MONTH + 17);
                }
            });

            it("Should revert if the current block timestamp has surpassed the next due date", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 14,
                });
                const endDate = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 13,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                await expect(
                    calendarContract.getDaysRemainingInPeriod(endDate.unix()),
                ).to.be.revertedWithCustomError(calendarContract, "StartDateLaterThanEndDate");
            });
        });

        describe("With semi-annually period duration", function () {
            it("Should return the correct values if the day is the 1st and the period", async function () {
                const nextYear = moment.utc().year() + 1;
                for (let i = 0; i < 12; i++) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 1,
                    });
                    // `endDate` is the start of the next quarter relative to `netxBlockTime`.
                    const endDate = moment.utc({
                        year: nextYear + (i < 6 ? 0 : 1),
                        month: ((Math.floor(i / 6) + 1) * 6) % 12,
                        day: 1,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                        endDate.unix(),
                    );
                    expect(daysRemaining).to.equal((6 - (i % 6)) * CONSTANTS.DAYS_IN_A_MONTH);
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
                    const endDate = moment.utc({
                        year: nextYear + (i < 6 ? 0 : 1),
                        month: ((Math.floor(i / 6) + 1) * 6) % 12,
                        day: 1,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                        endDate.unix(),
                    );
                    expect(daysRemaining).to.equal((5 - (i % 6)) * CONSTANTS.DAYS_IN_A_MONTH + 1);
                }
            });

            it("Should return the correct values otherwise", async function () {
                const nextYear = moment.utc().year() + 1;
                for (let i = 0; i < 12; i++) {
                    const nextBlockTime = moment.utc({
                        year: nextYear,
                        month: i,
                        day: 14,
                    });
                    const endDate = moment.utc({
                        year: nextYear + (i < 6 ? 0 : 1),
                        month: ((Math.floor(i / 6) + 1) * 6) % 12,
                        day: 1,
                    });
                    await mineNextBlockWithTimestamp(nextBlockTime.unix());
                    const daysRemaining = await calendarContract.getDaysRemainingInPeriod(
                        endDate.unix(),
                    );
                    expect(daysRemaining).to.equal((5 - (i % 6)) * CONSTANTS.DAYS_IN_A_MONTH + 17);
                }
            });

            it("Should revert if the current block timestamp has surpassed the next due date", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 14,
                });
                const endDate = moment.utc({
                    year: nextYear,
                    month: 1,
                    day: 13,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                await expect(
                    calendarContract.getDaysRemainingInPeriod(endDate.unix()),
                ).to.be.revertedWithCustomError(calendarContract, "StartDateLaterThanEndDate");
            });
        });
    });

    describe("getDaysDiff", function () {
        describe("When the start and end dates fall within the same month", function () {
            describe("When the start date is 0", function () {
                let endDate: moment.Moment;

                async function setCurrentBlockTS() {
                    const nextYear = moment.utc().year() + 1;
                    const startDate = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 29,
                    });
                    await mineNextBlockWithTimestamp(startDate.unix());

                    endDate = moment.utc({
                        year: nextYear,
                        month: 0,
                        day: 30,
                    });
                }

                beforeEach(async function () {
                    await loadFixture(setCurrentBlockTS);
                });

                it("Should use the current block timestamp as the start date", async function () {
                    expect(await calendarContract.getDaysDiff(0, endDate.unix())).to.equal(1);
                });
            });

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

            it("Should return the correct number of days if the start and end dates are in different years", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 14,
                });
                const endDate = moment.utc({
                    year: 2025,
                    month: 2,
                    day: 27,
                });
                expect(
                    await calendarContract.getDaysDiff(startDate.unix(), endDate.unix()),
                ).to.equal(433);
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
                ).to.be.revertedWithCustomError(calendarContract, "StartDateLaterThanEndDate");
            });
        });
    });

    describe("getDaysDiffSincePreviousPeriodStart", function () {
        describe("With monthly period duration", function () {
            describe("If the number of periods passed is 0", function () {
                it("Should return the correct number of days in between", async function () {
                    const timestamp = moment.utc({
                        year: 2024,
                        month: 2,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getDaysDiffSincePreviousPeriodStart(
                            PayPeriodDuration.Monthly,
                            0,
                            timestamp.unix(),
                        ),
                    ).to.equal(9);
                });
            });

            describe("If the number of periods passed is greater then 0", function () {
                it("Should return the correct number of days in between", async function () {
                    const timestamp = moment.utc({
                        year: 2024,
                        month: 2,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getDaysDiffSincePreviousPeriodStart(
                            PayPeriodDuration.Monthly,
                            2,
                            timestamp.unix(),
                        ),
                    ).to.equal(69);
                });
            });
        });

        describe("With quarterly period duration", function () {
            describe("If the number of periods passed is 0", function () {
                it("Should return the correct number of days in between", async function () {
                    const timestamp = moment.utc({
                        year: 2024,
                        month: 2,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getDaysDiffSincePreviousPeriodStart(
                            PayPeriodDuration.Quarterly,
                            0,
                            timestamp.unix(),
                        ),
                    ).to.equal(69);
                });
            });

            describe("If the number of periods passed is greater then 0", function () {
                it("Should return the correct number of days in between", async function () {
                    const timestamp = moment.utc({
                        year: 2024,
                        month: 2,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getDaysDiffSincePreviousPeriodStart(
                            PayPeriodDuration.Quarterly,
                            2,
                            timestamp.unix(),
                        ),
                    ).to.equal(253);
                });
            });
        });

        describe("With semi-annually period duration", function () {
            describe("If the number of periods passed is 0", function () {
                it("Should return the correct number of days in between", async function () {
                    const timestamp = moment.utc({
                        year: 2024,
                        month: 2,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getDaysDiffSincePreviousPeriodStart(
                            PayPeriodDuration.SemiAnnually,
                            0,
                            timestamp.unix(),
                        ),
                    ).to.equal(69);
                });
            });

            describe("If the number of periods passed is greater then 0", function () {
                it("Should return the correct number of days in between", async function () {
                    const timestamp = moment.utc({
                        year: 2024,
                        month: 2,
                        day: 10,
                    });
                    expect(
                        await calendarContract.getDaysDiffSincePreviousPeriodStart(
                            PayPeriodDuration.SemiAnnually,
                            2,
                            timestamp.unix(),
                        ),
                    ).to.equal(434);
                });
            });
        });
    });

    describe("getStartDateOfNextPeriod", function () {
        describe("With monthly period duration", function () {
            it("Should return the start date of the immediate next period relative to the current block timestamp if timestamp is 0", async function () {
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
            it("Should return the start date of the immediate next period relative to the current block timestamp if timestamp is 0", async function () {
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

            it("Should return the start date of the immediate next period relative to the current block timestamp if timestamp is 0 and the next period is in the next year", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 10,
                    day: 2,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const startDateOfNextPeriod = moment.utc({
                    year: nextYear + 1,
                    month: 0,
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
            it("Should return the start date of the immediate next period relative to the current block timestamp if timestamp is 0", async function () {
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

            it("Should return the start date of the immediate next period relative to the current block timestamp if timestamp is 0 and the next period is in the next year", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 10,
                    day: 2,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());
                const startDateOfNextPeriod = moment.utc({
                    year: nextYear + 1,
                    month: 0,
                    day: 1,
                });
                expect(
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.SemiAnnually,
                        0,
                    ),
                ).to.equal(startDateOfNextPeriod.unix());
            });

            it("Should return the start date of the immediate next period relative to the given timestamp if it's not 0 and the next period is in the next year", async function () {
                const nextYear = moment.utc().year() + 1;
                const nextBlockTime = moment.utc({
                    year: nextYear,
                    month: 0,
                    day: 2,
                });
                await mineNextBlockWithTimestamp(nextBlockTime.unix());

                const timestamp = moment.utc({
                    year: nextYear,
                    month: 8,
                    day: 2,
                });
                // The start date should be based on `timestamp` rather `nextBlockTime`.
                const startDateOfNextPeriod = moment.utc({
                    year: nextYear + 1,
                    month: 0,
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

    describe("getNumPeriodsPassed", function () {
        describe("With monthly period duration", function () {
            it("Should return 0 if the start and end dates are the same", async function () {
                const date = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        date.unix(),
                        date.unix(),
                    ),
                ).to.equal(0);
            });

            it("Should return 0 if the start and end dates are within the same period", async function () {
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
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(0);
            });

            it("Should return 1 if the end date is at the beginning of the next period but the start date is in the middle of a period", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 2,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 1 if both the start and end dates are on period boundaries", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 1,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 2,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 1 if the end date is in the immediate next period of the start date", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 2,
                    day: 14,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart and both are on period boundaries", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 1,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 4,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(3);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart and both are in the middle of a period", async function () {
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
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(2);
            });

            it("Should revert if the start date is later than the end date", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 14,
                });
                await expect(
                    calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Monthly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.be.revertedWithCustomError(calendarContract, "StartDateLaterThanEndDate");
            });
        });

        describe("With quarterly period duration", function () {
            it("Should return 0 if the start and end dates are the same", async function () {
                const date = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Quarterly,
                        date.unix(),
                        date.unix(),
                    ),
                ).to.equal(0);
            });

            it("Should return 1 if the end date is at the beginning of the next period but the start date is in the middle of a period", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Quarterly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 1 if both the start and end dates are on period boundaries", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 1,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Quarterly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 1 if the end date is in the immediate next period of the start date", async function () {
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
                ).to.equal(1);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart and both are on period boundaries", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 1,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 9,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Quarterly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(3);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart and both are in the middle of a period", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2025,
                    month: 0,
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

            it("Should revert if the start date is later than the end date", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 14,
                });
                await expect(
                    calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.Quarterly,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.be.revertedWithCustomError(calendarContract, "StartDateLaterThanEndDate");
            });
        });

        describe("With semi-annually period duration", function () {
            it("Should return 0 if the start and end dates are the same", async function () {
                const date = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        date.unix(),
                        date.unix(),
                    ),
                ).to.equal(0);
            });

            it("Should return 0 if the start and end dates are within the same period", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 28,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(0);
            });

            it("Should return 1 if the end date is at the beginning of the next period but the start date is in the middle of a period", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 6,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 1 if both the start and end dates are on period boundaries", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 1,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 6,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(1);
            });

            it("Should return 1 if the end date is in the immediate next period of the start date", async function () {
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
                ).to.equal(1);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart and both are on period boundaries", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 0,
                    day: 1,
                });
                const endDate = moment.utc({
                    year: 2025,
                    month: 6,
                    day: 1,
                });
                expect(
                    await calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.equal(3);
            });

            it("Should return the correct number of periods if the start and end dates are many different periods apart and both are in the middle of a period", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 1,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2025,
                    month: 3,
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

            it("Should revert if the start date is later than the end date", async function () {
                const startDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 15,
                });
                const endDate = moment.utc({
                    year: 2024,
                    month: 3,
                    day: 14,
                });
                await expect(
                    calendarContract.getNumPeriodsPassed(
                        PayPeriodDuration.SemiAnnually,
                        startDate.unix(),
                        endDate.unix(),
                    ),
                ).to.be.revertedWithCustomError(calendarContract, "StartDateLaterThanEndDate");
            });
        });
    });

    describe("getStartDateOfPeriod", function () {
        it("Should return the start of the month for the monthly period duration", async function () {
            const timestamp = moment.utc({
                year: 2024,
                month: 5,
                day: 30,
            });
            const expectedStartDate = moment.utc({
                year: 2024,
                month: 5,
                day: 1,
            });
            expect(
                await calendarContract.getStartDateOfPeriod(
                    PayPeriodDuration.Monthly,
                    timestamp.unix(),
                ),
            ).to.equal(expectedStartDate.unix());
        });

        it("Should return the start of the month for the quarterly period duration", async function () {
            const timestamp = moment.utc({
                year: 2024,
                month: 5,
                day: 30,
            });
            const expectedStartDate = moment.utc({
                year: 2024,
                month: 3,
                day: 1,
            });
            expect(
                await calendarContract.getStartDateOfPeriod(
                    PayPeriodDuration.Quarterly,
                    timestamp.unix(),
                ),
            ).to.equal(expectedStartDate.unix());
        });

        it("Should return the start of the month for the semi-annually period duration", async function () {
            const timestamp = moment.utc({
                year: 2024,
                month: 5,
                day: 30,
            });
            const expectedStartDate = moment.utc({
                year: 2024,
                month: 0,
                day: 1,
            });
            expect(
                await calendarContract.getStartDateOfPeriod(
                    PayPeriodDuration.SemiAnnually,
                    timestamp.unix(),
                ),
            ).to.equal(expectedStartDate.unix());
        });
    });

    describe("getTotalDaysInFullPeriod", function () {
        it("Should return 30 for monthly periods", async function () {
            expect(
                await calendarContract.getTotalDaysInFullPeriod(PayPeriodDuration.Monthly),
            ).to.equal(CONSTANTS.DAYS_IN_A_MONTH);
        });

        it("Should return 90 for quarterly periods", async function () {
            expect(
                await calendarContract.getTotalDaysInFullPeriod(PayPeriodDuration.Quarterly),
            ).to.equal(CONSTANTS.DAYS_IN_A_QUARTER);
        });

        it("Should return 180 for semi-annually periods", async function () {
            expect(
                await calendarContract.getTotalDaysInFullPeriod(PayPeriodDuration.SemiAnnually),
            ).to.equal(CONSTANTS.DAYS_IN_A_HALF_YEAR);
        });
    });
});
