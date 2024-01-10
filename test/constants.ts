import { BigNumber as BN } from "ethers";

const DAYS_IN_A_MONTH = 30;
const DAYS_IN_A_QUARTER = 90;
const DAYS_IN_A_HALF_YEAR = 180;
const DAYS_IN_A_YEAR = 360;
const SENIOR_TRANCHE = 0;
const JUNIOR_TRANCHE = 1;
const DEFAULT_DECIMALS_FACTOR = BN.from(10).pow(18);
const BP_FACTOR = BN.from(10000);
const MONTHS_IN_A_YEAR = 12;
const SECONDS_IN_A_DAY = 24 * 60 * 60;
const SECONDS_IN_A_YEAR = 60 * 60 * 24 * 365;
const BORROWER_LOSS_COVER_INDEX = 0;
const INSURANCE_LOSS_COVER_INDEX = 1;
const ADMIN_LOSS_COVER_INDEX = 2;

export const CONSTANTS = {
    DAYS_IN_A_MONTH,
    DAYS_IN_A_QUARTER,
    DAYS_IN_A_HALF_YEAR,
    DAYS_IN_A_YEAR,
    SENIOR_TRANCHE,
    JUNIOR_TRANCHE,
    DEFAULT_DECIMALS_FACTOR,
    BP_FACTOR,
    MONTHS_IN_A_YEAR,
    SECONDS_IN_A_DAY,
    SECONDS_IN_A_YEAR,
    BORROWER_LOSS_COVER_INDEX,
    ADMIN_LOSS_COVER_INDEX,
};

export enum LocalPoolName {
    CreditLine = "CreditLine",
    ReceivableBackedCreditLine = "ReceivableBackedCreditLine",
}
