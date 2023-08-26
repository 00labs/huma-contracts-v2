const {network} = require("hardhat");
const {BigNumber: BN} = require("ethers");
const moment = require("moment");

function toBN(number, decimals) {
    return BN.from(number).mul(BN.from(10).pow(BN.from(decimals)));
}

function toToken(number, decimals = 6) {
    return toBN(number, decimals);
}

async function setNextBlockTimestamp(nextTS) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [nextTS],
    });
}

async function mineNextBlockWithTimestamp(nextTS) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [nextTS],
    });
    await network.provider.send("evm_mine", []);
}

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

module.exports = {
    toBN,
    toToken,
    setNextBlockTimestamp,
    mineNextBlockWithTimestamp,
    getNextDate,
    getNextMonth,
};
