// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "./DealStructs.sol";

import {IDealLogic} from "./IDealLogic.sol";
import {IPaymentStrategy} from "./IPaymentStrategy.sol";
import {IScheduleStrategy} from "./IScheduleStrategy.sol";

contract DealLogic is IDealLogic {
    mapping(uint256 => IScheduleStrategy) public scheduleStrategies;
    mapping(uint256 => IPaymentStrategy) public paymentStrategies;

    function calculateInterestAndPincipal(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        DealConfig memory dealConfig
    ) external view override returns (uint256 accruedInterest, uint256 accruedPrincipal) {
        IScheduleStrategy ss = scheduleStrategies[dealConfig.scheduleOption];
        IPaymentStrategy ps = paymentStrategies[dealConfig.paymentOption];
        while (lastUpdatedTime < block.timestamp) {
            uint256[] memory ssParams;
            if (dealConfig.intervalDays > 0) {
                ssParams = new uint256[](4);
                ssParams[3] = dealConfig.intervalDays;
            } else {
                ssParams = new uint256[](3);
            }
            ssParams[0] = startTime;
            ssParams[1] = lastUpdatedTime;
            ssParams[2] = dealConfig.periodCount;
            uint256 endTime = ss.getNextDueDate(ssParams);
            uint256 interval;
            if (endTime > block.timestamp) {
                interval = block.timestamp - lastUpdatedTime;
            } else {
                interval = endTime - lastUpdatedTime;
            }
            uint256[] memory psParams = new uint256[](3);
            psParams[0] = principal;
            psParams[1] = interval;
            psParams[2] = dealConfig.aprInBps;
            (uint256 interestPart, uint256 principalPart) = ps.calculateInterestAndPrincipal(
                psParams
            );
            accruedInterest += interestPart;
            accruedPrincipal += principalPart;

            lastUpdatedTime += interval;
        }
    }
}
