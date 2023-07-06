// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

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
    uint256 public constant SENIOR_TRANCHE_INDEX = 0;
    uint256 public constant JUNIOR_TRANCHE_INDEX = 1;
    uint256 public constant RATIO_DECIMALS = 10000;

    IERC20 public asset;
    PoolInfo public poolInfo;
    uint256 public flexLoanPeriod;

    uint256 public liquidityCap;
    uint256 public maxSeniorRatio;

    function getTrancheLiquidityCap(uint256 index) external returns (uint256 cap) {
        if (index == SENIOR_TRANCHE_INDEX) {
            cap = (liquidityCap * maxSeniorRatio) / (maxSeniorRatio + RATIO_DECIMALS);
        } else if (index == JUNIOR_TRANCHE_INDEX) {
            cap = liquidityCap / (maxSeniorRatio + RATIO_DECIMALS);
        }
    }
}
