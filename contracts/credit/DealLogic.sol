// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "./DealStructs.sol";

import {IDealLogic} from "./interfaces/IDealLogic.sol";
import {IPaymentStrategy} from "./interfaces/IPaymentStrategy.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";

contract DealLogic is IDealLogic {
    mapping(uint256 => ICalendar) public scheduleStrategies;
    mapping(uint256 => IPaymentStrategy) public paymentStrategies;

    function calculateInterestAndPincipal(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        DealConfig memory dealConfig
    ) external view override returns (uint256 accruedInterest, uint256 accruedPrincipal) {
        ICalendar ss = scheduleStrategies[dealConfig.scheduleOption];
        IPaymentStrategy ps = paymentStrategies[dealConfig.paymentOption];
        while (lastUpdatedTime < block.timestamp) {
            // prepare schedule strategy parameters
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

            // get next due date
            uint256 endTime = ss.getNextDueDate(ssParams);

            // calculate the interval to the next due date
            uint256 interval;
            if (endTime > block.timestamp) {
                interval = block.timestamp - lastUpdatedTime;
            } else {
                interval = endTime - lastUpdatedTime;
            }

            // prepare payment strategy parameters
            uint256[] memory psParams = new uint256[](3);
            psParams[0] = principal;
            psParams[1] = interval;
            psParams[2] = dealConfig.aprInBps;

            // get accrued interest and accrued principal
            (uint256 interestPart, uint256 principalPart) = ps.calculateInterestAndPrincipal(
                psParams
            );

            // update result
            accruedInterest += interestPart;
            accruedPrincipal += principalPart;

            // calculate late fee

            lastUpdatedTime += interval;
        }
    }
}
