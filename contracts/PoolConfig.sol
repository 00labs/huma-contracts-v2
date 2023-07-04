// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

struct PoolInfo {
    CalenderType calenderType;
    uint16 interval;
    uint16 graceDays;
    uint16 aprInBps;
    uint16 lateAprInBps;
    uint16 frontLoadingFeeInBps;
}

enum CalenderType {
    Day,
    SemiMoth
}

contract PoolConfig {
    PoolInfo public poolInfo;
    uint256 public flexLoanPeriod;

    uint256 public liquidityCap;
    uint256 public maxSeniorRatio;
}
