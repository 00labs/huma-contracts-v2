// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Constants} from "./Constants.sol";

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

contract PoolConfig is Constants {
    address public asset;
    PoolInfo public poolInfo;
    uint256 public flexLoanPeriod;

    uint256 public liquidityCap;
    uint256 public maxSeniorRatio;

    // TODO permission for all set functions
    // TODO events for all set functions

    function setAsset(address _asset) external {
        asset = _asset;
    }

    function setPoolInfo(PoolInfo memory _poolInfo) external {
        poolInfo = _poolInfo;
    }

    function setFlexLoanPeriod(uint256 _flexLoanPeriod) external {
        flexLoanPeriod = _flexLoanPeriod;
    }

    function setLiquidityCap(uint256 _liquidityCap) external {
        liquidityCap = _liquidityCap;
    }

    function setMaxSeniorRatio(uint256 _maxSeniorRatio) external {
        maxSeniorRatio = _maxSeniorRatio;
    }

    function getTrancheLiquidityCap(uint256 index) external view returns (uint256 cap) {
        if (index == SENIOR_TRANCHE_INDEX) {
            cap = (liquidityCap * maxSeniorRatio) / (maxSeniorRatio + BPS_DECIMALS);
        } else if (index == JUNIOR_TRANCHE_INDEX) {
            cap = liquidityCap / (maxSeniorRatio + BPS_DECIMALS);
        }
    }
}
