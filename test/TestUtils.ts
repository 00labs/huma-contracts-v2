import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN, Contract } from "ethers";
import { ethers, network } from "hardhat";
import moment from "moment";
import { FirstLossCover, Pool, PoolConfig } from "../typechain-types";
import { FirstLossCoverStorage } from "../typechain-types/contracts/FirstLossCover";
import {
    FirstLossCoverConfigStruct,
    LPConfigStructOutput,
} from "../typechain-types/contracts/PoolConfig.sol/PoolConfig";
import { CONSTANTS, FirstLossCoverInfo } from "./BaseTest";

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
    await setNextBlockTimestamp(nextTS);
    await network.provider.send("evm_mine", []);
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

export function getNextDueDate(
    lastDueDateTimestamp: number,
    currentTimestamp: number,
    periodDuration: number,
) {
    let date: moment.Moment;
    let numberOfPeriodsPassed = 0;
    let monthCount = 0;
    if (lastDueDateTimestamp > 0) {
        date = timestampToMoment(lastDueDateTimestamp);
        numberOfPeriodsPassed = Math.floor(
            timestampToMoment(currentTimestamp).diff(date, "months") / periodDuration,
        );
    } else {
        date = timestampToMoment(currentTimestamp, "YYYY-MM-01");
        monthCount = 1;
    }
    monthCount += (numberOfPeriodsPassed + 1) * periodDuration;
    date.add(monthCount, "months");
    return [date.unix(), numberOfPeriodsPassed];
}

export async function getFutureBlockTime(offsetSeconds: number) {
    const block = await getLatestBlock();
    const currentTimestampInSeconds = Math.ceil(Date.now() / 1000);
    return Math.max(block.timestamp, currentTimestampInSeconds) + offsetSeconds;
}

export function getStartDateOfPeriod(periodDuration: number, endDate: number): number {
    return timestampToMoment(endDate).subtract(periodDuration, "months").unix();
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

export async function overrideLPConfig(
    poolConfigContract: PoolConfig,
    poolOwner: SignerWithAddress,
    overrides: Partial<LPConfigStructOutput>,
) {
    const lpConfig = await poolConfigContract.getLPConfig();
    const newLPConfig = {
        ...lpConfig,
        ...overrides,
    };
    await poolConfigContract.connect(poolOwner).setLPConfig(newLPConfig);
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

export async function overrideLossCoverProviderConfig(
    firstLossCoverContract: FirstLossCover,
    provider: SignerWithAddress,
    poolOwner: SignerWithAddress,
    override: Partial<FirstLossCoverStorage.LossCoverProviderConfigStruct>,
) {
    const config = await firstLossCoverContract.getCoverProviderConfig(provider.getAddress());
    const newConfig = {
        ...config,
        ...override,
    };
    await firstLossCoverContract
        .connect(poolOwner)
        .setCoverProvider(provider.getAddress(), newConfig);
}

export async function overrideFirstLossCoverConfig(
    firstLossCoverContract: FirstLossCover,
    firstLossCoverProfitEscrowAddress: string,
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
            firstLossCoverProfitEscrowAddress,
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

export async function borrowerLevelCreditHash(
    creditContract: Contract,
    borrower: SignerWithAddress,
) {
    return ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "address"],
            [creditContract.address, await borrower.getAddress()],
        ),
    );
}
