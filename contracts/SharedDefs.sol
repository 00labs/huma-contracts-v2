// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

uint256 constant SENIOR_TRANCHE_INDEX = 0;
uint256 constant JUNIOR_TRANCHE_INDEX = 1;
uint256 constant HUNDRED_PERCENT_IN_BPS = 10000;
uint256 constant MAX_PERIODS = 360;

enum CalendarUnit {
    Day,
    SemiMonth // half a month.
}
