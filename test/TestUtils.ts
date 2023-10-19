import { ethers, network } from "hardhat";
import { BigNumber as BN } from "ethers";
import moment from "moment";
import {
    FirstLossCoverConfigStruct,
    LPConfigStructOutput,
} from "../typechain-types/contracts/PoolConfig.sol/PoolConfig";
import { CONSTANTS, FirstLossCoverInfo } from "./BaseTest";
import { FirstLossCover, Pool, PoolConfig, ProfitEscrow } from "../typechain-types";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

export function toBN(number: string | number, decimals: number): BN {
    return BN.from(number).mul(BN.from(10).pow(BN.from(decimals)));
}

export function toToken(number: string | number, decimals: number = 6): BN {
    return toBN(number, decimals);
}

export function sumBNArray(arr: BN[]): BN {
    return arr.reduce((acc, curValue) => acc.add(curValue), BN.from(0));
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
    let date: moment.Moment;
    let numberOfPeriodsPassed = 0;
    let dayCount = 0;
    if (lastDate > 0) {
        date = timestampToMoment(lastDate);
        numberOfPeriodsPassed = Math.floor(
            timestampToMoment(currentDate).diff(date, "days") / periodDuration,
        );
    } else {
        date = timestampToMoment(currentDate, "YYYY-MM-DD");
        dayCount = 1;
    }
    dayCount += (numberOfPeriodsPassed + 1) * periodDuration;
    date.add(dayCount, "days");
    return [date.unix(), numberOfPeriodsPassed];
}

export function getNextMonth(lastDate: number, currentDate: number, periodDuration: number) {
    let date: moment.Moment;
    let numberOfPeriodsPassed = 0;
    let monthCount = 0;
    if (lastDate > 0) {
        date = timestampToMoment(lastDate);
        numberOfPeriodsPassed = Math.floor(
            timestampToMoment(currentDate).diff(date, "months") / periodDuration,
        );
    } else {
        date = timestampToMoment(currentDate, "YYYY-MM-01");
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

export function getStartDateOfPeriod(
    calendarUnit: number,
    periodDuration: number,
    endDate: number,
): number {
    if (calendarUnit == CONSTANTS.CALENDAR_UNIT_DAY) {
        return timestampToMoment(endDate).subtract(periodDuration, "days").unix();
    } else if (calendarUnit == CONSTANTS.CALENDAR_UNIT_MONTH) {
        return timestampToMoment(endDate).subtract(periodDuration, "months").unix();
    } else {
        return 0;
    }
}

export async function getLatestBlock() {
    return await ethers.provider.getBlock("latest");
}

export function timestampToMoment(timestamp: number, format?: string): moment.Moment {
    if (format) {
        const date = moment.unix(timestamp).utc().format(format);
        return moment.unix(dateToTimestamp(date)).utc();
    }
    return moment.unix(timestamp).utc();
}

export function dateToTimestamp(date: string): number {
    return moment.utc(date).unix();
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

export async function getMinFirstLossCoverRequirement(
    firstLossCoverContract: FirstLossCover,
    poolConfigContract: PoolConfig,
    poolContract: Pool,
    account: string,
): Promise<BN> {
    const lossCoverProviderConfig = await firstLossCoverContract.getCoverProviderConfig(account);
    const lpConfig = await poolConfigContract.getLPConfig();
    const poolCap = lpConfig.liquidityCap;
    const minFromPoolCap = poolCap
        .mul(lossCoverProviderConfig.poolCapCoverageInBps)
        .div(CONSTANTS.BP_FACTOR);
    const poolValue = await poolContract.totalAssets();
    const minFromPoolValue = poolValue
        .mul(lossCoverProviderConfig.poolValueCoverageInBps)
        .div(CONSTANTS.BP_FACTOR);
    return minFromPoolCap.gt(minFromPoolValue) ? minFromPoolCap : minFromPoolValue;
}

export async function getMinLiquidityRequirementForPoolOwner(
    poolConfigContract: PoolConfig,
): Promise<BN> {
    const lpConfig = await poolConfigContract.getLPConfig();
    const poolCap = lpConfig.liquidityCap;
    const adminRnR = await poolConfigContract.getAdminRnR();
    return poolCap.mul(adminRnR.liquidityRateInBpsByPoolOwner).div(CONSTANTS.BP_FACTOR);
}

export async function getMinLiquidityRequirementForEA(
    poolConfigContract: PoolConfig,
): Promise<BN> {
    const lpConfig = await poolConfigContract.getLPConfig();
    const poolCap = lpConfig.liquidityCap;
    const adminRnR = await poolConfigContract.getAdminRnR();
    return poolCap.mul(adminRnR.liquidityRateInBpsByEA).div(CONSTANTS.BP_FACTOR);
}

export async function getFirstLossCoverInfo(
    firstLossCoverContract: FirstLossCover,
    poolConfigContract: PoolConfig,
): Promise<FirstLossCoverInfo> {
    const totalAssets = await firstLossCoverContract.totalAssets();
    const config = await poolConfigContract.getFirstLossCoverConfig(
        firstLossCoverContract.address,
    );
    return {
        config,
        asset: totalAssets,
    };
}

export async function overrideFirstLossCoverConfig(
    firstLossCoverContract: FirstLossCover,
    firstLossCoverProfitEscrowContract: ProfitEscrow,
    firstLossCoverIndex: number,
    poolConfigContract: PoolConfig,
    poolOwner: SignerWithAddress,
    overrides: Partial<FirstLossCoverConfigStruct>,
) {
    const config = await poolConfigContract.getFirstLossCoverConfig(
        firstLossCoverContract.address,
    );
    const newConfig = {
        ...config,
        ...overrides,
    };
    await poolConfigContract
        .connect(poolOwner)
        .setFirstLossCover(
            firstLossCoverIndex,
            firstLossCoverContract.address,
            newConfig,
            firstLossCoverProfitEscrowContract.address,
        );
}

export function maxBigNumber(...values: BN[]): BN {
    return values.reduce((acc, currentValue) => {
        return acc.gt(currentValue) ? acc : currentValue;
    }, BN.from(0));
}

export function minBigNumber(...values: BN[]): BN {
    return values.reduce((acc, currentValue) => {
        return acc.lt(currentValue) ? acc : currentValue;
    }, BN.from(ethers.constants.MaxUint256));
}
