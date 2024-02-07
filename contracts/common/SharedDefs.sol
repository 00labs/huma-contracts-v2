// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

uint256 constant DAYS_IN_A_MONTH = 30;
uint256 constant DAYS_IN_A_QUARTER = 90;
uint256 constant DAYS_IN_A_HALF_YEAR = 180;
uint256 constant DAYS_IN_A_YEAR = 360;
uint256 constant SENIOR_TRANCHE = 0;
uint256 constant JUNIOR_TRANCHE = 1;
uint256 constant HUNDRED_PERCENT_IN_BPS = 10000;
uint256 constant SECONDS_IN_A_DAY = 1 days;
uint256 constant DEFAULT_DECIMALS_FACTOR = 1e18;
uint256 constant BORROWER_LOSS_COVER_INDEX = 0;
uint256 constant INSURANCE_LOSS_COVER_INDEX = 1;
uint256 constant ADMIN_LOSS_COVER_INDEX = 2;

enum PayPeriodDuration {
    Monthly,
    Quarterly,
    SemiAnnually
}
