import { ethers, network } from "hardhat";
import { BigNumber as BN } from "ethers";
import moment from "moment";
import { LPConfigStructOutput } from "../typechain-types/contracts/PoolConfig";

export function toBN(number: string | number, decimals: number): BN {
    return BN.from(number).mul(BN.from(10).pow(BN.from(decimals)));
}

export function toToken(number: string | number, decimals: number = 6): BN {
    return toBN(number, decimals);
}

export async function setNextBlockTimestamp(nextTS: BN | number) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [Number(nextTS)],
    });
}

export async function mineNextBlockWithTimestamp(nextTS: BN | number) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [Number(nextTS)],
    });
}

export function getNextDate(
    lastDate: number,
    currentDate: number,
    periodDuration: number,
): number[] {
    let date;
    let numberOfPeriodsPassed = 0;
    let dayCount = 0;
    if (lastDate > 0) {
        date = moment.unix(lastDate);
        numberOfPeriodsPassed = Math.floor(
            moment.unix(currentDate).diff(date, "days") / periodDuration,
        );
    } else {
        date = moment.utc(moment.unix(currentDate).utc().format("YYYY-MM-DD"));
        dayCount = 1;
    }
    dayCount += (numberOfPeriodsPassed + 1) * periodDuration;
    date.add(dayCount, "days");
    return [date.unix(), numberOfPeriodsPassed];
}

export function getNextMonth(lastDate: number, currentDate: number, periodDuration: number) {
    let date;
    let numberOfPeriodsPassed = 0;
    let monthCount = 0;
    if (lastDate > 0) {
        date = moment.unix(lastDate);
        numberOfPeriodsPassed = Math.floor(
            moment.unix(currentDate).diff(date, "months") / periodDuration,
        );
    } else {
        date = moment.utc(moment.unix(currentDate).utc().format("YYYY-MM-01"));
        monthCount = 1;
    }
    monthCount += (numberOfPeriodsPassed + 1) * periodDuration;
    date.add(monthCount, "months");
    return [date.unix(), numberOfPeriodsPassed];
}

export async function getNextTime(afterSeconds: number) {
    let nextTime = Math.ceil(Date.now() / 1000) + afterSeconds;
    const block = await getLatestBlock();
    if (block.timestamp >= nextTime) {
        nextTime = block.timestamp + afterSeconds;
    }

    return nextTime;
}

export async function getLatestBlock() {
    return await ethers.provider.getBlock("latest");
}

export function copyLPConfigWithOverrides(
    lpConfig: LPConfigStructOutput,
    overrides: Partial<LPConfigStructOutput>,
) {
    return {
        ...{
            permissioned: lpConfig.permissioned,
            liquidityCap: lpConfig.liquidityCap,
            withdrawalLockoutInCalendarUnit: lpConfig.withdrawalLockoutInCalendarUnit,
            maxSeniorJuniorRatio: lpConfig.maxSeniorJuniorRatio,
            fixedSeniorYieldInBps: lpConfig.fixedSeniorYieldInBps,
            tranchesRiskAdjustmentInBps: lpConfig.tranchesRiskAdjustmentInBps,
        },
        ...overrides,
    };
}
