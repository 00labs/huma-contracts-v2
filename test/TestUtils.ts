import { ethers, network } from "hardhat";
import moment from "moment";
import { LPConfigStructOutput } from "../typechain-types/contracts/PoolConfig";

export function toBN(number: string | number, decimals: number): bigint {
    return BigInt(number) * 10n ** BigInt(decimals);
}

export function toToken(number: string | number, decimals: number = 6): bigint {
    return toBN(number, decimals);
}

export async function setNextBlockTimestamp(nextTS: bigint | number) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [Number(nextTS)],
    });
}

export async function mineNextBlockWithTimestamp(nextTS: bigint | number) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [Number(nextTS)],
    });
    await network.provider.send("evm_mine", []);
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

export async function getLatestBlock() {
    return await ethers.provider.getBlock("latest");
}

export function overrideLPConfig(
    lpConfig: LPConfigStructOutput,
    overrides: Partial<LPConfigStructOutput>,
) {
    return {
        ...{
            permissioned: lpConfig.permissioned,
            liquidityCap: lpConfig.liquidityCap,
            withdrawalLockoutInCalendarUnit: lpConfig.withdrawalLockoutInCalendarUnit,
            maxSeniorJuniorRatio: lpConfig.maxSeniorJuniorRatio,
            tranchesRiskAdjustmentInBps: lpConfig.tranchesRiskAdjustmentInBps,
            fixedSeniorYieldInBps: lpConfig.fixedSeniorYieldInBps,
        },
        ...overrides,
    };
}
